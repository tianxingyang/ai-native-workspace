use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const RESOURCE_KEYS: [&str; 6] = [
    "menu_show",
    "menu_quit",
    "window_title",
    "notification_title",
    "notification_body",
    "short_description",
];

pub struct Registry {
    pub selected: String,
    pub fallback: String,
    pub catalogs: BTreeMap<String, String>,
}

fn identifier(value: &str) -> bool {
    value.len() <= 64
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && value
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric()))
}

impl Registry {
    pub fn parse(manifest: &Value) -> Result<Self, String> {
        if manifest["schemaVersion"] != 1 || manifest["mode"] != "demo" {
            return Err("Expected version 1 demo desktop manifest".into());
        }
        let entries = manifest["catalogs"]
            .as_array()
            .ok_or("Expected registered desktop catalogs")?;
        let mut catalogs = BTreeMap::new();
        for entry in entries {
            let locale = entry["locale"].as_str().ok_or("Missing desktop locale")?;
            let file = entry["file"]
                .as_str()
                .ok_or("Missing desktop catalog file")?;
            if !identifier(locale)
                || !file.strip_suffix(".json").is_some_and(identifier)
                || catalogs
                    .insert(locale.to_owned(), file.to_owned())
                    .is_some()
            {
                return Err("Invalid or duplicate registered desktop catalog".into());
            }
        }
        let selected = manifest["selected"]
            .as_str()
            .ok_or("Missing selected demo locale")?;
        let fallback = manifest["fallback"]
            .as_str()
            .ok_or("Missing fallback demo locale")?;
        if !catalogs.contains_key(selected) || !catalogs.contains_key(fallback) {
            return Err("Selected and fallback desktop locales must be registered".into());
        }
        Ok(Self {
            selected: selected.to_owned(),
            fallback: fallback.to_owned(),
            catalogs,
        })
    }

    pub fn resolve(&self, catalogs: &BTreeMap<String, Value>) -> Result<Value, String> {
        for locale in self.catalogs.keys() {
            let catalog = catalogs
                .get(locale)
                .and_then(Value::as_object)
                .ok_or_else(|| format!("Missing desktop catalog: {locale}"))?;
            for (key, value) in catalog {
                if !RESOURCE_KEYS.contains(&key.as_str())
                    || value.as_str().is_none_or(|s| s.trim().is_empty())
                {
                    return Err(format!("Invalid desktop resource: {locale}.{key}"));
                }
            }
        }
        let selected = &catalogs[&self.selected];
        let fallback = &catalogs[&self.fallback];
        let mut resolved = Map::new();
        for key in RESOURCE_KEYS {
            // The fallback must be complete, even when the selected catalog overrides a key.
            let base = fallback
                .get(key)
                .ok_or_else(|| format!("Missing fallback desktop resource: {key}"))?;
            resolved.insert(key.to_owned(), selected.get(key).unwrap_or(base).clone());
        }
        Ok(Value::Object(resolved))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({"schemaVersion": 1, "mode": "demo", "selected": "test-XA", "fallback": "test-XB",
            "catalogs": [{"locale": "test-XA", "file": "test-XA.json"}, {"locale": "test-XB", "file": "test-XB.json"}]})
    }

    #[test]
    fn registered_selection_uses_only_missing_key_fallback() {
        let registry = Registry::parse(&manifest()).unwrap();
        let base = Value::Object(
            RESOURCE_KEYS
                .into_iter()
                .map(|key| (key.to_owned(), json!(key)))
                .collect(),
        );
        let mut catalogs = BTreeMap::from([
            (
                "test-XA".into(),
                json!({"window_title": "Synthetic \"title\" \\ <&>\n"}),
            ),
            ("test-XB".into(), base),
        ]);
        let resolved = registry.resolve(&catalogs).unwrap();
        assert_eq!(resolved["window_title"], "Synthetic \"title\" \\ <&>\n");
        assert_eq!(resolved["notification_body"], "notification_body");
        catalogs.get_mut("test-XA").unwrap()["window_title"] = Value::Null;
        assert!(registry
            .resolve(&catalogs)
            .unwrap_err()
            .contains("Invalid desktop resource"));
        catalogs.get_mut("test-XA").unwrap()["window_title"] = json!("title");
        catalogs
            .get_mut("test-XB")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("window_title");
        assert!(registry
            .resolve(&catalogs)
            .unwrap_err()
            .contains("Missing fallback"));
    }

    #[test]
    fn manifest_rejects_unknown_selection_duplicates_and_external_paths() {
        let mut unknown = manifest();
        unknown["selected"] = json!("unknown");
        assert!(Registry::parse(&unknown).is_err());
        for file in [
            "../outside.json",
            "/absolute.json",
            "C:\\secret.json",
            "https://example.com/catalog.json",
            "catalog.json?x",
        ] {
            let mut invalid = manifest();
            invalid["catalogs"][0]["file"] = json!(file);
            assert!(Registry::parse(&invalid).is_err());
        }
        let mut duplicate = manifest();
        duplicate["catalogs"][1]["locale"] = json!("test-XA");
        assert!(Registry::parse(&duplicate).is_err());
    }
}
