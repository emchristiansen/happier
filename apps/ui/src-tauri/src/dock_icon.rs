//! Running-app Dock icon on macOS.
//!
//! Since macOS 26 every bundled app icon is drawn on the system's square tile,
//! so the notch in Happier's mark shows the tile colour instead of the Dock
//! behind it. An image set at runtime through
//! `NSApplication.applicationIconImage` is drawn as-is, which keeps the notch
//! transparent while the app runs. Tauri already does this for dev builds only
//! (`#[cfg(dev)]` in tauri's `app.rs`); this applies the same artwork in every
//! build.
//!
//! Finder, Launchpad and the Dock before launch still show the bundled
//! `icons/AppIcon.icon`; only the running app's Dock tile changes.

/// The mark in the macOS icon grid (824 of 1024, with the system icon shadow) on a transparent
/// canvas, so it sits the same size as every bundled icon; `scripts/generateDesktopIcons.mjs`.
#[cfg(target_os = "macos")]
const DOCK_ICON_PNG: &[u8] = include_bytes!("../icons/dock/dock-icon.png");

/// Must run on the main thread (Tauri's `setup` hook does).
#[cfg(target_os = "macos")]
pub fn apply() {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("dock_icon::apply called off the main thread; keeping the bundle icon");
        return;
    };
    let data = NSData::with_bytes(DOCK_ICON_PNG);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        log::warn!("could not decode the Dock icon PNG; keeping the bundle icon");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

#[cfg(not(target_os = "macos"))]
pub fn apply() {}
