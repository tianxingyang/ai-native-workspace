use serde::Deserialize;
use std::{
    io::BufRead,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

// Opt-in acceptance bootstrap comes only from the native launcher's private stdin.
// The WebView cannot select a server, credential or profile directory.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recovery {
    pub url: String,
    pub owner_token: String,
    pub expires_at: u64,
    pub profile_directory: PathBuf,
}

impl Recovery {
    pub fn parse(line: &str, now: u64) -> Result<Self, &'static str> {
        let value: Self = serde_json::from_str(line).map_err(|_| "invalid_recovery_bootstrap")?;
        let port = value.url.strip_prefix("http://127.0.0.1:").unwrap_or("");
        let path = value.profile_directory.to_string_lossy();
        if line.len() > 8192
            || port.is_empty()
            || port.starts_with('0')
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().ok().filter(|p| *p > 0).is_none()
            || value.owner_token.len() != 64
            || !value
                .owner_token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || value.expires_at <= now
            || value.expires_at > now.saturating_add(30 * 60 * 1000)
            || !value.profile_directory.is_absolute()
            || path.starts_with("\\\\")
            || path.starts_with("//")
            || value
                .profile_directory
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("invalid_recovery_bootstrap");
        }
        Ok(value)
    }
    pub fn read() -> Result<Self, &'static str> {
        let mut bytes = Vec::new();
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        // Bound input before allocating; no credentials in errors or diagnostics.
        loop {
            let buffer = input.fill_buf().map_err(|_| "invalid_recovery_bootstrap")?;
            if buffer.is_empty() {
                return Err("invalid_recovery_bootstrap");
            }
            let count = buffer
                .iter()
                .position(|b| *b == b'\n')
                .map_or(buffer.len(), |i| i + 1);
            if bytes.len() + count > 8192 {
                return Err("invalid_recovery_bootstrap");
            }
            bytes.extend_from_slice(&buffer[..count]);
            input.consume(count);
            if bytes.last() == Some(&b'\n') {
                break;
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid_clock")?
            .as_millis() as u64;
        Self::parse(
            std::str::from_utf8(&bytes).map_err(|_| "invalid_recovery_bootstrap")?,
            now,
        )
    }
    pub fn connection(&self) -> serde_json::Value {
        serde_json::json!({"url": self.url, "ownerToken": self.owner_token, "expiresAt": self.expires_at})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_bounded_local_launcher_input() {
        let valid = serde_json::json!({"url":"http://127.0.0.1:45678", "ownerToken":"a".repeat(64),
            "expiresAt":2000, "profileDirectory":"C:\\acceptance\\profile"});
        assert!(Recovery::parse(&valid.to_string(), 1000).is_ok());
        for (key, bad) in [
            ("url", serde_json::json!("https://example.com")),
            ("url", serde_json::json!("http://127.0.0.1:45678/path")),
            ("url", serde_json::json!("http://127.0.0.1:65536")),
            ("ownerToken", serde_json::json!("secret\n")),
            ("expiresAt", serde_json::json!(1000)),
            ("expiresAt", serde_json::json!(1801001)),
            ("profileDirectory", serde_json::json!("relative")),
            ("profileDirectory", serde_json::json!("\\\\server\\share")),
            (
                "profileDirectory",
                serde_json::json!("C:\\acceptance\\..\\elsewhere"),
            ),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = bad;
            assert!(
                Recovery::parse(&invalid.to_string(), 1000).is_err(),
                "{key}"
            );
        }
    }
}
