use std::{collections::BTreeMap, env, fs, path::PathBuf};

#[path = "locales/registry.rs"]
mod registry;

fn main() {
    // This manifest selects the existing demo build, not the product's default language.
    println!("cargo:rerun-if-changed=locales/manifest.json");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let manifest =
        serde_json::from_str(&fs::read_to_string("locales/manifest.json").unwrap()).unwrap();
    let registry = registry::Registry::parse(&manifest).expect("Invalid desktop manifest");
    let catalogs = registry
        .catalogs
        .iter()
        .map(|(locale, file)| {
            let path = format!("locales/{file}");
            println!("cargo:rerun-if-changed={path}");
            let catalog = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            (locale.clone(), catalog)
        })
        .collect::<BTreeMap<_, _>>();
    let catalog = registry
        .resolve(&catalogs)
        .expect("Invalid desktop resources");
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    let windows = config["app"]["windows"].as_array().unwrap();
    let main_windows: Vec<_> = windows.iter().filter(|w| w["label"] == "main").collect();
    assert_eq!(main_windows.len(), 1, "Expected exactly one main window");
    for (actual, key) in [
        (&main_windows[0]["title"], "window_title"),
        (&config["bundle"]["shortDescription"], "short_description"),
    ] {
        let expected = catalog[key].as_str().expect("Missing desktop resource");
        assert!(!expected.trim().is_empty(), "Empty desktop resource: {key}");
        assert_eq!(
            actual.as_str(),
            Some(expected),
            "Stale desktop configuration; run npm run desktop:resources"
        );
    }
    let mut generated = format!("pub const DEMO_LOCALE: &str = {:?};\npub const SELECTED_DEMO: DemoPresentation = DemoPresentation {{\n", registry.selected);
    for (field, key) in [
        ("menu_show", "menu_show"),
        ("menu_quit", "menu_quit"),
        ("tray_tooltip", "window_title"),
        ("window_title", "window_title"),
        ("notification_title", "notification_title"),
        ("notification_body", "notification_body"),
    ] {
        let value = catalog[key].as_str().expect("Missing desktop resource");
        assert!(!value.trim().is_empty(), "Empty desktop resource: {key}");
        // Rust Debug escaping produces a Rust string literal, including control characters.
        generated.push_str(&format!("    {field}: {value:?},\n"));
    }
    generated.push_str("};\n");
    generated.push_str("// Compatibility alias for the existing demo callers.\npub const DEMO_ZH_CN: DemoPresentation = SELECTED_DEMO;\n");
    generated.push_str(&format!(
        "#[cfg(test)]\nconst RESOLVED_DEMO_JSON: &str = {:?};\n",
        catalog.to_string()
    ));
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("demo_presentation.rs"),
        generated,
    )
    .unwrap();
    tauri_build::build()
}
