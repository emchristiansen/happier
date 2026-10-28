//! Menu-bar mode decisions, pure (no tauri types).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tray::model::{AutostartMode, MenuPlatform, TrayLabels, TrayMenuModel, UpdatesItem};

/// The login item's argument: start as a tray-only process, with no window and no web UI (R16 b).
pub const MENU_BAR_ARG: &str = "--menu-bar";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MainWindowDestination {
    Updates,
    Settings,
    Relay(String),
}

impl MainWindowDestination {
    pub fn pending_payload(&self) -> String {
        match self {
            Self::Updates => "updates".to_string(),
            Self::Settings => "settings".to_string(),
            Self::Relay(url) => format!("relay:{url}"),
        }
    }

    pub fn event_payload(&self) -> Value {
        match self {
            Self::Relay(url) => serde_json::json!({ "relayUrl": url }),
            Self::Updates | Self::Settings => Value::Null,
        }
    }
}

pub fn launched_in_menu_bar_mode<I, S>(args: I, update_relaunch: bool) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    !update_relaunch
        && args
            .into_iter()
            .skip(1)
            .any(|arg| arg.as_ref() == MENU_BAR_ARG)
}

/// A second launch while Happier runs (single instance) opens its window — except the login item
/// firing again, which asks for nothing the running app is not already doing.
pub fn second_launch_opens_main_window<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    !launched_in_menu_bar_mode(args, false)
}

/// R16 (b) — the app starts at login exactly when the background service does, so there is one
/// setting, not two. Unknown leaves whatever is there: nothing proved which way to move it.
pub fn app_autostart_target(mode: Option<AutostartMode>) -> Option<bool> {
    mode.map(|mode| mode == AutostartMode::AtLogin)
}

/// What asked for a native status read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusReadTrigger {
    /// The app just became tray-only (a quit that kept running, or a login start).
    EnteredMenuBar,
    /// The pointer reached the tray icon or pressed it — the moment before its menu opens on
    /// macOS and Windows (neither exposes "menu will open" through tray-icon).
    TrayPointer,
    /// Linux's slow timer: AppIndicator reports neither hover nor click.
    Timer,
    /// A tray action changed a service.
    AfterAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayPointerRefreshTarget {
    Native,
    Webview,
    Suppressed,
}

/// The existing main webview owns inspection while it exists; otherwise the native reader does.
pub fn tray_pointer_refresh_target(
    main_webview_exists: bool,
    since_last_refresh: Option<Duration>,
) -> TrayPointerRefreshTarget {
    if main_webview_exists {
        if pointer_refresh_is_due(since_last_refresh) {
            TrayPointerRefreshTarget::Webview
        } else {
            TrayPointerRefreshTarget::Suppressed
        }
    } else {
        TrayPointerRefreshTarget::Native
    }
}

/// Pointer events arrive in bursts (enter, move, click). One read per this interval is fresh enough
/// for a glance and keeps a hovering pointer from spawning a CLI run each time; an action's own
/// re-read is never throttled.
pub const POINTER_READ_MIN_INTERVAL: Duration = Duration::from_secs(15);

fn pointer_refresh_is_due(since_last_refresh: Option<Duration>) -> bool {
    since_last_refresh.is_none_or(|elapsed| elapsed >= POINTER_READ_MIN_INTERVAL)
}

/// Linux only, and only while tray-only: a read spawns hsetup and the CLI, so this is the slowest
/// cadence that still lets the menu catch a daemon that stopped on its own within a minute.
pub const LINUX_STATUS_TIMER_INTERVAL: Duration = Duration::from_secs(60);

/// The single native reader's admission and settlement while tray-only. An overlapping action
/// retains one follow-up read; pointer and timer demand never queue another read.
#[derive(Default)]
pub struct StatusReadState {
    read_in_flight: bool,
    pending_after_action: bool,
}

impl StatusReadState {
    pub fn request(
        &mut self,
        trigger: StatusReadTrigger,
        menu_bar_mode: bool,
        since_last_read: Option<Duration>,
        last_read_failed: bool,
    ) -> bool {
        if !menu_bar_mode {
            self.leave();
            return false;
        }
        if self.read_in_flight && trigger == StatusReadTrigger::AfterAction {
            self.pending_after_action = true;
        }
        if !should_start_status_read(
            trigger,
            menu_bar_mode,
            self.read_in_flight,
            since_last_read,
            last_read_failed,
        ) {
            return false;
        }
        self.read_in_flight = true;
        true
    }

    /// Returns whether the worker has another read to perform.
    pub fn finish(&mut self, menu_bar_mode: bool) -> bool {
        let pending = std::mem::take(&mut self.pending_after_action);
        self.read_in_flight = menu_bar_mode && pending;
        self.read_in_flight
    }

    pub fn leave(&mut self) {
        self.pending_after_action = false;
    }
}

#[cfg(test)]
mod status_read_tests {
    use super::*;

    #[test]
    fn overlapping_actions_retain_one_unthrottled_read_after_the_old_read_settles() {
        for last_read_failed in [false, true] {
            let mut reads = StatusReadState::default();
            assert!(reads.request(StatusReadTrigger::TrayPointer, true, None, false));
            for _ in 0..2 {
                assert!(!reads.request(
                    StatusReadTrigger::AfterAction,
                    true,
                    Some(Duration::ZERO),
                    false
                ));
            }
            assert!(!reads.request(StatusReadTrigger::Timer, true, None, false));
            assert!(
                reads.finish(true),
                "the completed action still needs a fresh observation"
            );
            assert!(!reads.request(StatusReadTrigger::TrayPointer, true, None, last_read_failed));
            assert!(
                !reads.finish(true),
                "the coalesced obligation is consumed exactly once"
            );
            assert!(reads.request(
                StatusReadTrigger::AfterAction,
                true,
                Some(Duration::ZERO),
                last_read_failed
            ));
        }
    }

    #[test]
    fn leaving_tray_only_clears_and_ignores_action_obligations() {
        let mut reads = StatusReadState::default();
        assert!(reads.request(StatusReadTrigger::TrayPointer, true, None, false));
        assert!(!reads.request(StatusReadTrigger::AfterAction, true, None, false));
        reads.leave();
        assert!(!reads.request(StatusReadTrigger::AfterAction, false, None, false));
        assert!(
            !reads.finish(true),
            "reopening tray-only must not restore the abandoned obligation"
        );

        assert!(reads.request(StatusReadTrigger::EnteredMenuBar, true, None, false));
        assert!(!reads.request(StatusReadTrigger::AfterAction, true, None, false));
        assert!(!reads.finish(false));
        assert!(!reads.finish(true));
    }

    #[test]
    fn ordinary_pointer_and_timer_overlap_does_not_queue_a_read() {
        let mut reads = StatusReadState::default();
        assert!(reads.request(StatusReadTrigger::EnteredMenuBar, true, None, false));
        assert!(!reads.request(StatusReadTrigger::TrayPointer, true, None, false));
        assert!(!reads.request(StatusReadTrigger::Timer, true, None, false));
        assert!(!reads.finish(true));
        assert!(!reads.request(
            StatusReadTrigger::TrayPointer,
            true,
            Some(Duration::ZERO),
            false
        ));
        assert!(reads.request(
            StatusReadTrigger::TrayPointer,
            true,
            Some(Duration::ZERO),
            true
        ));
        assert!(!reads.finish(true));
    }
}

fn should_start_status_read(
    trigger: StatusReadTrigger,
    menu_bar_mode: bool,
    read_in_flight: bool,
    since_last_read: Option<Duration>,
    last_read_failed: bool,
) -> bool {
    if !menu_bar_mode || read_in_flight {
        return false;
    }
    match trigger {
        // A read that failed is retried the next time the menu is about to open.
        StatusReadTrigger::TrayPointer => {
            last_read_failed || pointer_refresh_is_due(since_last_read)
        }
        StatusReadTrigger::EnteredMenuBar
        | StatusReadTrigger::Timer
        | StatusReadTrigger::AfterAction => true,
    }
}

/// Only Linux needs the timer, and only while no web UI pushes state.
pub fn status_timer_needed(platform: MenuPlatform, menu_bar_mode: bool) -> bool {
    platform == MenuPlatform::Linux && menu_bar_mode
}

/// What the web UI last told the native side, kept on disk so a login start (no web UI yet) and
/// menu-bar mode have its localized labels (U14), its Updates item and the exact task params its
/// one spec builder produces (`buildLocalDaemonServiceSystemTaskSpec`), plus the last-known
/// login-start setting observed by either reader or changed through the native toggle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedTrayState {
    pub labels: TrayLabels,
    /// `daemon.service.status.v1`'s params as the web UI builds them (target, surface, mode,
    /// channel). `None` until the web UI ran once: the native side then reads nothing.
    pub task_params: Option<Value>,
    pub updates: Option<UpdatesItem>,
    /// Relay URL → the name the web UI shows for it.
    pub relay_names: BTreeMap<String, String>,
    /// The last observed login-start setting, available before the first cold-launch read.
    pub start_at_login: Option<bool>,
}

impl PersistedTrayState {
    /// Records an observation for the next cold launch, without changing the current tray model.
    pub fn observe_login_start(&mut self, mode: Option<bool>) -> bool {
        if mode.is_none() || self.start_at_login == mode {
            return false;
        }
        self.start_at_login = mode;
        true
    }

    /// The cold-launch model, before either the web UI or native status reader runs.
    pub fn initial_model(&self, platform: MenuPlatform) -> TrayMenuModel {
        let mut model = TrayMenuModel::new(platform);
        model.labels = self.labels.clone();
        model.updates = self.updates.clone();
        model.start_at_login = self.start_at_login;
        model
    }
}

/// A missing, unreadable or foreign file is the same as no file: English labels, no reads.
pub fn parse_persisted_tray_state(bytes: Option<&[u8]>) -> PersistedTrayState {
    let state = bytes
        .and_then(|bytes| serde_json::from_slice::<PersistedTrayState>(bytes).ok())
        .unwrap_or_default();
    PersistedTrayState {
        labels: state.labels.with_fallbacks(),
        task_params: state.task_params.filter(Value::is_object),
        ..state
    }
}

/// The spec a native run sends to hsetup: the web UI's params plus the kind's own fields.
pub fn build_native_task_spec(
    kind: &str,
    base_params: &Value,
    extra: &[(&str, Value)],
) -> Option<String> {
    let mut params = base_params.as_object()?.clone();
    for (key, value) in extra {
        params.insert((*key).to_string(), value.clone());
    }
    serde_json::to_string(&serde_json::json!({
        "protocolVersion": 1,
        "kind": kind,
        "params": Value::Object(params),
    }))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_pending_relay_pick_preserves_the_whole_url_and_existing_screen_destinations() {
        let url = "https://work.example.com:8443/relay?q=a:b";
        assert_eq!(
            MainWindowDestination::Relay(url.into()).pending_payload(),
            format!("relay:{url}")
        );
        assert_eq!(MainWindowDestination::Updates.pending_payload(), "updates");
        assert_eq!(
            MainWindowDestination::Settings.pending_payload(),
            "settings"
        );
        assert_eq!(
            MainWindowDestination::Relay(url.into()).event_payload(),
            json!({ "relayUrl": url })
        );
    }

    #[test]
    fn the_login_item_argument_selects_menu_bar_mode_and_the_binary_path_never_does() {
        assert!(launched_in_menu_bar_mode(
            ["/Applications/Happier.app/x", "--menu-bar"],
            false
        ));
        assert!(!launched_in_menu_bar_mode(
            ["/Applications/Happier.app/x"],
            false
        ));
        assert!(!launched_in_menu_bar_mode(["--menu-bar"], false));
    }

    #[test]
    fn an_update_relaunch_opens_the_window_even_when_originally_started_at_login() {
        assert!(!launched_in_menu_bar_mode(["Happier", "--menu-bar"], true));
        assert!(!launched_in_menu_bar_mode(["Happier"], true));
    }

    #[test]
    fn a_second_launch_opens_the_window_unless_it_is_the_login_item_again() {
        assert!(second_launch_opens_main_window([
            "/Applications/Happier.app/x"
        ]));
        // The login item firing while Happier already runs: it is already in the menu bar.
        assert!(!second_launch_opens_main_window([
            "/Applications/Happier.app/x",
            "--menu-bar"
        ]));
    }

    #[test]
    fn the_app_starts_at_login_exactly_when_the_service_does_and_unknown_changes_nothing() {
        assert_eq!(
            app_autostart_target(Some(AutostartMode::AtLogin)),
            Some(true)
        );
        assert_eq!(
            app_autostart_target(Some(AutostartMode::OnDemand)),
            Some(false)
        );
        assert_eq!(app_autostart_target(None), None);
    }

    #[test]
    fn native_reads_happen_only_in_menu_bar_mode_one_at_a_time() {
        use StatusReadTrigger::*;
        assert!(!should_start_status_read(
            EnteredMenuBar,
            false,
            false,
            None,
            false
        ));
        assert!(!should_start_status_read(
            AfterAction,
            true,
            true,
            None,
            false
        ));
        assert!(should_start_status_read(
            EnteredMenuBar,
            true,
            false,
            None,
            false
        ));
        assert!(should_start_status_read(
            Timer,
            true,
            false,
            Some(Duration::from_secs(1)),
            false
        ));
        assert!(should_start_status_read(
            AfterAction,
            true,
            false,
            Some(Duration::ZERO),
            false
        ));
    }

    #[test]
    fn tray_pointer_demand_reaches_the_webview_owner_instead_of_being_lost() {
        assert_eq!(
            tray_pointer_refresh_target(true, None),
            TrayPointerRefreshTarget::Webview
        );
        assert_eq!(
            tray_pointer_refresh_target(false, None),
            TrayPointerRefreshTarget::Native
        );
    }

    #[test]
    fn pointer_bursts_do_not_request_multiple_webview_inspections() {
        assert_eq!(
            tray_pointer_refresh_target(true, None),
            TrayPointerRefreshTarget::Webview
        );
        assert_eq!(
            tray_pointer_refresh_target(true, Some(Duration::from_secs(14))),
            TrayPointerRefreshTarget::Suppressed
        );
        assert_eq!(
            tray_pointer_refresh_target(true, Some(POINTER_READ_MIN_INTERVAL)),
            TrayPointerRefreshTarget::Webview
        );
        // The native reader owns its in-flight, failed-read and after-action lifecycle.
        assert_eq!(
            tray_pointer_refresh_target(false, Some(Duration::ZERO)),
            TrayPointerRefreshTarget::Native
        );
    }

    #[test]
    fn a_failed_read_is_retried_the_next_time_the_menu_is_about_to_open() {
        assert!(should_start_status_read(
            StatusReadTrigger::TrayPointer,
            true,
            false,
            Some(Duration::from_secs(1)),
            true
        ));
    }

    #[test]
    fn pointer_reads_are_throttled_but_the_first_one_is_not() {
        use StatusReadTrigger::TrayPointer;
        assert!(should_start_status_read(
            TrayPointer,
            true,
            false,
            None,
            false
        ));
        assert!(!should_start_status_read(
            TrayPointer,
            true,
            false,
            Some(Duration::from_secs(14)),
            false
        ));
        assert!(should_start_status_read(
            TrayPointer,
            true,
            false,
            Some(POINTER_READ_MIN_INTERVAL),
            false
        ));
    }

    #[test]
    fn only_linux_in_menu_bar_mode_runs_the_timer() {
        assert!(status_timer_needed(MenuPlatform::Linux, true));
        assert!(!status_timer_needed(MenuPlatform::Linux, false));
        assert!(!status_timer_needed(MenuPlatform::MacOs, true));
        assert!(!status_timer_needed(MenuPlatform::Windows, true));
    }

    #[test]
    fn persisted_state_survives_garbage_and_keeps_english_for_missing_labels() {
        let empty = parse_persisted_tray_state(Some(b"not json"));
        assert_eq!(empty.labels.quit, "Quit Happier");
        assert_eq!(empty.task_params, None);
        assert_eq!(parse_persisted_tray_state(None).labels.open, "Open Happier");

        let saved = serde_json::to_vec(&json!({
            "labels": { "quit": "Happier beenden" },
            "taskParams": { "target": { "kind": "local" }, "channel": "preview" },
            "relayNames": { "https://a.example.com": "Work" }
        }))
        .unwrap();
        let state = parse_persisted_tray_state(Some(&saved));
        assert_eq!(state.labels.quit, "Happier beenden");
        assert_eq!(state.labels.open, "Open Happier");
        assert_eq!(state.relay_names["https://a.example.com"], "Work");
        assert!(state.task_params.is_some());
        // State written before login-start persistence must remain unknown, not OFF.
        assert_eq!(
            state.initial_model(MenuPlatform::Windows).start_at_login,
            None
        );

        let not_an_object = serde_json::to_vec(&json!({ "taskParams": "x" })).unwrap();
        assert_eq!(
            parse_persisted_tray_state(Some(&not_an_object)).task_params,
            None
        );
    }

    #[test]
    fn cold_launch_restores_the_last_known_login_start_setting_and_quit_label() {
        use crate::menu::ids::QUIT_APP_MENU_ID;
        use crate::tray::model::{build_menu_entries, MenuEntry};

        for setting in [Some(true), Some(false), None] {
            let bytes = serde_json::to_vec(&json!({ "startAtLogin": setting })).unwrap();
            let restored = parse_persisted_tray_state(Some(&bytes));
            let rewritten = serde_json::to_vec(&restored).unwrap();
            let model =
                parse_persisted_tray_state(Some(&rewritten)).initial_model(MenuPlatform::Windows);
            assert_eq!(model.start_at_login, setting);
            let expected_label = match setting {
                Some(true) => &model.labels.quit_keep_services,
                Some(false) => &model.labels.quit_stop_services,
                None => &model.labels.quit,
            };
            assert!(build_menu_entries(&model).iter().any(|entry| matches!(entry,
                MenuEntry::Item { id: Some(id), text, .. } if id == QUIT_APP_MENU_ID && text == expected_label
            )));
        }
    }

    #[test]
    fn an_unknown_current_mode_does_not_erase_the_last_proved_cold_launch_mode() {
        let mut saved = PersistedTrayState::default();
        for setting in [true, false] {
            assert!(saved.observe_login_start(Some(setting)));
            assert!(!saved.observe_login_start(None));
            let bytes = serde_json::to_vec(&saved).unwrap();
            let restored = parse_persisted_tray_state(Some(&bytes));
            assert_eq!(
                restored.initial_model(MenuPlatform::Windows).start_at_login,
                Some(setting)
            );
        }
    }

    #[test]
    fn a_native_spec_is_the_web_ui_params_plus_the_kind_fields() {
        let base = json!({ "target": { "kind": "local" }, "surface": "desktop.ui", "mode": "user", "channel": "stable" });
        let spec: Value = serde_json::from_str(
            &build_native_task_spec(
                "daemon.service.stop.v1",
                &base,
                &[("relayUrl", json!("https://a.example.com"))],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            spec,
            json!({
                "protocolVersion": 1,
                "kind": "daemon.service.stop.v1",
                "params": { "target": { "kind": "local" }, "surface": "desktop.ui", "mode": "user", "channel": "stable", "relayUrl": "https://a.example.com" }
            })
        );
        assert_eq!(build_native_task_spec("x", &json!("nope"), &[]), None);
    }
}
