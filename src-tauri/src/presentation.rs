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

pub const DEMO_ZH_CN: DemoPresentation = DemoPresentation {
    menu_show: "显示 CoSeat",
    menu_quit: "退出并结束本地演示",
    tray_tooltip: "CoSeat 同席 · 本地模拟版",
    window_title: "CoSeat 同席 · 本地模拟版",
    notification_title: "CoSeat 同席",
    notification_body: "团队讨论有新消息。点击返回会话；仅本地模拟资料。",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_fallback_matches_the_demo_window_title() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["windows"][0]["title"],
            DEMO_ZH_CN.window_title
        );
    }
}
