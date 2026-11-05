use std::{env, fs, path::PathBuf};

fn main() {
    // Keep the existing demo language explicit; this is not runtime locale selection.
    println!("cargo:rerun-if-changed=locales/zh-CN.json");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let catalog: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("locales/zh-CN.json").unwrap()).unwrap();
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
    let mut generated =
        String::from("pub const DEMO_ZH_CN: DemoPresentation = DemoPresentation {\n");
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
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("demo_presentation.rs"),
        generated,
    )
    .unwrap();
    tauri_build::build()
}
