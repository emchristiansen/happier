use std::ffi::OsStr;
use std::process::Command;

/// Native desktop helpers run in the background, including hsetup status reads and log openers.
/// Piped stdio does not suppress a Windows console; set the process creation flag as well.
/// A future explicit user-terminal action must use its terminal owner instead of this helper.
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
