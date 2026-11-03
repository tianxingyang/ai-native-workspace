#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
mod notifications;

struct Host {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
    quitting: AtomicBool,
    connected: AtomicBool,
    messages_received: AtomicU64,
    notifications_submitted: AtomicU64,
}

impl Host {
    fn request(&self, path: String, body: Option<Value>) -> Result<Value, String> {
        if self.quitting.load(Ordering::SeqCst) {
            return Err("desktop_stopped".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut data = json!({ "id": id, "path": path });
        if let Some(body) = body {
            data["body"] = body;
        }
        let sent = writeln!(self.stdin.lock().unwrap(), "{data}");
        let result = if sent.is_ok() {
            rx.recv_timeout(Duration::from_secs(7))
                .map_err(|_| "desktop_unavailable".into())
        } else {
            Err("desktop_unavailable".into())
        };
        self.pending.lock().unwrap().remove(&id);
        result
    }
    fn stop(&self) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = writeln!(self.stdin.lock().unwrap(), "{{\"command\":\"stop\"}}");
        let mut child = self.child.lock().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

// App commands are deliberately narrow. Neither a URL, executable, file path,
// token nor a notification payload can be supplied by web content.
fn permitted(path: &str, body: &Option<Value>) -> bool {
    if path.len() > 2048 || body.as_ref().is_some_and(|v| v.to_string().len() > 60000) {
        return false;
    }
    if body.is_some() {
        return path == "/messages"
            || path
                .strip_prefix("/runs/")
                .and_then(|p| p.strip_suffix("/cancel"))
                .is_some_and(|id| {
                    !id.is_empty()
                        && id.len() <= 100
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                });
    }
    path == "/session" || path.starts_with("/messages?") || path.starts_with("/runs?")
}

#[tauri::command]
async fn desktop_request(
    host: tauri::State<'_, Arc<Host>>,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !permitted(&path, &body) {
        return Err("request_denied".into());
    }
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.request(path, body))
        .await
        .map_err(|_| "desktop_unavailable".to_string())?
}

#[tauri::command]
fn desktop_connected(host: tauri::State<'_, Arc<Host>>, connected: bool) {
    host.connected.store(connected, Ordering::SeqCst);
}

#[tauri::command]
fn desktop_status(app: tauri::AppHandle, host: tauri::State<'_, Arc<Host>>) -> Value {
    let window = app.get_webview_window("main").unwrap();
    json!({ "connected": host.connected.load(Ordering::SeqCst),
        "messagesReceived": host.messages_received.load(Ordering::SeqCst),
        "notificationsSubmitted": host.notifications_submitted.load(Ordering::SeqCst),
        "visible": window.is_visible().unwrap_or(false), "focused": window.is_focused().unwrap_or(false) })
}

#[tauri::command]
fn desktop_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn desktop_present(app: tauri::AppHandle) {
    show(&app);
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(notifications::Notifications::default()))
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !notifications::queue_activation(app, args.into_iter().skip(1)) {
                show(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            desktop_connected,
            desktop_status,
            desktop_quit,
            desktop_present,
            notifications::desktop_take_notification
        ])
        .setup(|app| {
            let resource = app.path().resource_dir()?.join("runtime");
            let mut command = Command::new(resource.join("node.exe"));
            command
                .arg(resource.join("dist/scripts/desktop-host.js"))
                .current_dir(&resource)
                .env_clear()
                .env("PI_OFFLINE", "1")
                .env("DO_NOT_TRACK", "1")
                .creation_flags(0x08000000)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec"] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
            let mut child = command.spawn()?;
            let stdout = child.stdout.take().unwrap();
            let host = Arc::new(Host {
                stdin: Mutex::new(child.stdin.take().unwrap()),
                child: Mutex::new(child),
                pending: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
                quitting: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                messages_received: AtomicU64::new(0),
                notifications_submitted: AtomicU64::new(0),
            });
            app.manage(host.clone());
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    url.as_str().starts_with("http://tauri.localhost/")
                        || url.as_str().starts_with("tauri://localhost/")
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            notifications::queue_activation(app.handle(), std::env::args().skip(1));
            let event_app = app.handle().clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(data) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(id) = data["id"].as_u64() {
                        if let Some(sender) = host.pending.lock().unwrap().remove(&id) {
                            let _ = sender.send(data);
                        }
                    } else if data["event"] == "message" {
                        host.messages_received.fetch_add(1, Ordering::SeqCst);
                        if !host.connected.load(Ordering::SeqCst) {
                            continue;
                        }
                        let focused = event_app.get_webview_window("main").is_some_and(|w| {
                            w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)
                        });
                        if focused {
                            continue;
                        }
                        let notices = event_app.state::<Arc<notifications::Notifications>>();
                        let Some(expires_at) = data["expiresAt"].as_u64() else {
                            continue;
                        };
                        let Some(id) = notices.add(data["scope"].clone(), expires_at) else {
                            continue;
                        };
                        let submitted =
                            notifications::show(&event_app.config().identifier, &id, expires_at);
                        if submitted.is_ok() {
                            host.notifications_submitted.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                host.pending.lock().unwrap().clear();
            });
            let open = MenuItem::with_id(app, "show", "显示 CoSeat", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出并结束本地演示", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("CoSeat 同席 · 本地模拟版")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("CoSeat could not start its local demo")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(host) = app.try_state::<Arc<Host>>() {
                    host.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_rejects_privilege_expansion() {
        for path in [
            "https://example.com",
            "//example.com/messages",
            "/admin",
            "/runs/a/../cancel",
            "/runs/a%2f/cancel",
        ] {
            assert!(!permitted(path, &Some(json!({}))));
        }
        assert!(permitted("/messages", &Some(json!({"text":"hello"}))));
        assert!(permitted("/runs/run_123/cancel", &Some(json!({}))));
        assert!(!permitted(
            "/messages",
            &Some(json!({"text":"x".repeat(60001)}))
        ));
    }
}
