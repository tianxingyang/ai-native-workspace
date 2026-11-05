// Compile-time text for the existing demo, not a product default-language decision.
#[derive(Clone, Copy)]
pub struct DemoPresentation {
    pub menu_show: &'static str,
    pub menu_quit: &'static str,
    pub tray_tooltip: &'static str,
    pub window_title: &'static str,
    pub notification_title: &'static str,
    pub notification_body: &'static str,
}

// Generated at compile time from locales/zh-CN.json; never load external language files.
include!(concat!(env!("OUT_DIR"), "/demo_presentation.rs"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_resources_and_configuration_match_the_demo_catalog() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../locales/zh-CN.json")).unwrap();
        for (actual, key) in [
            (DEMO_ZH_CN.menu_show, "menu_show"),
            (DEMO_ZH_CN.menu_quit, "menu_quit"),
            (DEMO_ZH_CN.tray_tooltip, "window_title"),
            (DEMO_ZH_CN.window_title, "window_title"),
            (DEMO_ZH_CN.notification_title, "notification_title"),
            (DEMO_ZH_CN.notification_body, "notification_body"),
        ] {
            assert_eq!(actual, catalog[key].as_str().unwrap());
        }
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();
        assert_eq!(main["title"], DEMO_ZH_CN.window_title);
        assert_eq!(
            config["bundle"]["shortDescription"],
            catalog["short_description"]
        );
    }
}
