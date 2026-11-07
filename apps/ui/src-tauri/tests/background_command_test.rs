use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[path = "../src/background_command.rs"]
mod background_command;

#[test]
fn background_command_preserves_piped_io_without_a_windows_console() {
    // A real console-subsystem child observes its own console and exchanges task-like data.
    let mut child = background_command::background_command(std::env::current_exe().unwrap())
        .args(["--exact", "report_background_child_state", "--nocapture"])
        .env("HAPPIER_TEST_REPORT_BACKGROUND_CHILD", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("background child should start");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"task-spec\n")
        .unwrap();
    let output = child
        .wait_with_output()
        .expect("background child should exit");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("stdin=task-spec"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("background-child-stderr"));
    #[cfg(windows)]
    assert!(String::from_utf8_lossy(&output.stdout).contains("windows_console_attached=false"));
}

#[test]
fn report_background_child_state() {
    if std::env::var_os("HAPPIER_TEST_REPORT_BACKGROUND_CHILD").is_none() {
        return;
    }
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    println!("stdin={}", input.trim());
    eprintln!("background-child-stderr");
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        // This Windows API has no arguments or owned memory; it only observes this process.
        let attached = unsafe { !GetConsoleWindow().is_null() };
        println!("windows_console_attached={attached}");
    }
}

fn collect_rust_sources(root: &Path, paths: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("source directory should be readable") {
        let path = entry.expect("source entry should be readable").path();
        if path.is_dir() {
            collect_rust_sources(&path, paths);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            paths.push(path);
        }
    }
}

#[test]
fn desktop_background_processes_use_the_console_suppressing_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    collect_rust_sources(&root, &mut paths);
    let mut bypasses = Vec::new();
    for path in paths {
        if path == root.join("background_command.rs") {
            continue;
        }
        if path.file_name().is_some_and(|name| name == "tests.rs") {
            let parent = fs::read_to_string(path.parent().unwrap().join("mod.rs"))
                .expect("external test module should have an owning module");
            let parent: String = parent
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            assert!(
                parent.contains("#[cfg(test)]modtests;"),
                "test module must be test-only"
            );
            continue;
        }
        let source = fs::read_to_string(&path).expect("Rust source should be readable");
        let source: String = source
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        // Test fixtures may launch deliberately visible child processes. Production commands
        // belong to the background owner; no desktop path currently opens a user terminal.
        let production = source
            .split("#[cfg(test)]modtests{")
            .next()
            .unwrap_or(&source);
        if production.contains("Command::new") {
            bypasses.push(path.strip_prefix(&root).unwrap().display().to_string());
        }
    }
    assert!(
        bypasses.is_empty(),
        "background process owner bypasses: {bypasses:?}"
    );
}
