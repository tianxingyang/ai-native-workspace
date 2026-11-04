//! Windows handles protocol activation even after a banner moves to Notification
//! Center. The URI is an opaque, in-memory navigation reference, never authority.
use crate::{
    presentation::{DemoPresentation, DEMO_ZH_CN},
    Host,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use windows::{
    core::{Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};

const PREFIX: &str = "coseat-demo-notice://notification/";

#[derive(Clone)]
pub struct Notice {
    pub scope: Value,
    pub expires_at: u64,
}

#[derive(Default)]
pub struct Notifications {
    entries: Mutex<HashMap<String, Notice>>,
    pending: Mutex<Option<String>>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_uri(value: &str) -> Option<&str> {
    let id = value.strip_prefix(PREFIX)?;
    (id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(id)
}

impl Notifications {
    pub fn add(&self, scope: Value, expires_at: u64) -> Option<String> {
        let now = now_ms();
        if expires_at <= now || expires_at > now.saturating_add(30 * 60 * 1000) {
            return None;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, notice| notice.expires_at > now);
        if entries.len() >= 128 {
            entries.clear();
        }
        entries.insert(id.clone(), Notice { scope, expires_at });
        Some(id)
    }

    fn lookup(&self, id: &str, now: u64) -> Option<Notice> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|n| n.expires_at > now)
            .cloned()
    }
}

/// No runtime registration. The installer owns one static per-user URI scheme;
/// arbitrary URLs and extra CLI arguments are not accepted as navigation.
pub fn queue_activation(app: &tauri::AppHandle, args: impl Iterator<Item = String>) -> bool {
    let args: Vec<_> = args.collect();
    if args.len() != 1 || !args[0].starts_with("coseat-demo-notice:") {
        return false;
    }
    let notices = app.state::<Arc<Notifications>>();
    *notices.pending.lock().unwrap() = Some(parse_uri(&args[0]).unwrap_or("").to_string());
    // Keep a hidden window hidden until the renderer has cleared stale content
    // and refreshed the authorized source. Cold start already shows only login.
    let _ = app.emit_to("main", "desktop-notification", ());
    true
}

#[tauri::command]
pub async fn desktop_take_notification(
    host: tauri::State<'_, Arc<Host>>,
    notices: tauri::State<'_, Arc<Notifications>>,
) -> Result<Value, String> {
    let Some(id) = notices.pending.lock().unwrap().take() else {
        return Ok(json!({"kind":"none"}));
    };
    let Some(notice) = notices.lookup(&id, now_ms()) else {
        return Ok(json!({"kind":"unavailable","reason":"ended"}));
    };
    if !host.connected.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(json!({"kind":"unavailable","reason":"disconnected"}));
    }
    let host = host.inner().clone();
    let response =
        tauri::async_runtime::spawn_blocking(move || host.request("/session".into(), None))
            .await
            .map_err(|_| "desktop_unavailable")??;
    if response["status"] != 200 {
        return Ok(json!({"kind":"unauthorized", "status": response["status"]}));
    }
    if !authorized_scope(&response["value"], &notice.scope) || notice.expires_at <= now_ms() {
        return Ok(json!({"kind":"unauthorized", "status":403}));
    }
    Ok(json!({"kind":"open", "scope":notice.scope}))
}

fn authorized_scope(session: &Value, scope: &Value) -> bool {
    session["scopes"].as_array().is_some_and(|scopes| {
        scopes.iter().any(|s| {
            s["conversationId"].as_str().is_some()
                && s["threadId"].as_str().is_some()
                && s["conversationId"] == scope["conversationId"]
                && s["threadId"] == scope["threadId"]
        })
    })
}

fn toast_xml(id: &str, text: DemoPresentation) -> String {
    fn escape(value: &str) -> String {
        value
            .chars()
            .map(|c| match c {
                '&' => "&amp;".into(),
                '<' => "&lt;".into(),
                '>' => "&gt;".into(),
                '"' => "&quot;".into(),
                '\'' => "&apos;".into(),
                _ => c.to_string(),
            })
            .collect()
    }
    let title = escape(text.notification_title);
    let body = escape(text.notification_body);
    // id is the existing generated lowercase-hex reference, never resource text.
    format!("<toast activationType=\"protocol\" launch=\"{PREFIX}{id}\"><visual><binding template=\"ToastGeneric\"><text>{title}</text><text>{body}</text></binding></visual></toast>")
}

pub fn show(app_id: &str, id: &str, expires_at: u64) -> windows::core::Result<()> {
    // This function runs on the dedicated reader thread, not the UI STA.
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(id, DEMO_ZH_CN)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.SetTag(&HSTRING::from(&id[..16]))?;
    toast.SetGroup(&HSTRING::from("local-demo"))?;
    let expiration: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
        UniversalTime: ((expires_at + 11_644_473_600_000) * 10_000) as i64,
    })?
    .cast()?;
    toast.SetExpirationTime(&expiration)?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
    if notifier.Setting()? != NotificationSetting::Enabled {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80070005u32 as i32,
        )));
    }
    notifier.Show(&toast)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_resources_round_trip_as_text_without_extra_nodes() {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        let text = DemoPresentation {
            notification_title: "中文 <&>\"' &amp;",
            notification_body: "</text><audio src='injected'/><text>原样 &amp;",
            ..DEMO_ZH_CN
        };
        let id = "0123456789abcdef0123456789abcdef";
        let document = XmlDocument::new().unwrap();
        document
            .LoadXml(&HSTRING::from(toast_xml(id, text)))
            .unwrap();
        let nodes = document
            .GetElementsByTagName(&HSTRING::from("text"))
            .unwrap();
        assert_eq!(nodes.Length().unwrap(), 2);
        assert_eq!(
            nodes.Item(0).unwrap().InnerText().unwrap().to_string(),
            text.notification_title
        );
        assert_eq!(
            nodes.Item(1).unwrap().InnerText().unwrap().to_string(),
            text.notification_body
        );
        assert_eq!(
            document
                .GetElementsByTagName(&HSTRING::from("audio"))
                .unwrap()
                .Length()
                .unwrap(),
            0
        );
        assert!(toast_xml(id, text).contains(&format!("launch=\"{PREFIX}{id}\"")));
        drop(nodes);
        drop(document);
        unsafe {
            RoUninitialize();
        }
    }
    #[test]
    fn uri_is_only_an_opaque_reference() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse_uri(&format!("{PREFIX}{id}")), Some(id));
        for uri in [
            format!("{PREFIX}{id}?token=bad"),
            format!("{PREFIX}{id}/"),
            format!("{PREFIX}%30{id}"),
            "https://example.invalid".into(),
            "coseat-demo-notice://notification/../../file".into(),
        ] {
            assert_eq!(parse_uri(&uri), None);
        }
    }
    #[test]
    fn notifications_do_not_survive_expiry_or_restart_and_never_grant_scope() {
        let notices = Notifications::default();
        let now = now_ms();
        let scope = json!({"conversationId":"test","threadId":"one"});
        let id = notices.add(scope.clone(), now + 1000).unwrap();
        assert!(notices.lookup(&id, now).is_some());
        assert!(notices.lookup(&id, now + 1001).is_none());
        assert!(Notifications::default().lookup(&id, now).is_none());
        assert!(!authorized_scope(&json!({"scopes":[]}), &scope));
        assert!(!authorized_scope(
            &json!({"scopes":[{"conversationId":"test","threadId":"two"}]}),
            &scope
        ));
        assert!(authorized_scope(&json!({"scopes":[scope.clone()]}), &scope));
        assert!(notices.add(scope, now + 31 * 60 * 1000).is_none());
    }
}
