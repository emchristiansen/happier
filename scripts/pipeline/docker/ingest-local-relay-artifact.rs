//! Receipt-bound local input for the artifact-based relay Docker target.
//! Build with `rustc --edition=2021 -Dwarnings ingest-local-relay-artifact.rs`.
//! Compile tests with `rustc --edition=2021 -Dwarnings --test ...`; set
//! HAPPIER_RELAY_INGEST_BINARY to the separately compiled executable when running.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

type Result<T> = std::result::Result<T, String>;

struct LocalArtifact {
    directory: PathBuf,
    archive: String,
    envelope: String,
    digest: String,
    destination: PathBuf,
}

fn hex(value: String, length: usize, name: &str) -> Result<String> {
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{name} must be full {length}-digit hexadecimal"));
    }
    Ok(value.to_ascii_lowercase())
}

impl LocalArtifact {
    fn parse(args: impl Iterator<Item = OsString>) -> Result<Self> {
        let mut args = args;
        let mut values = BTreeMap::new();
        while let Some(key) = args.next() {
            let key = key.into_string().map_err(|_| "non-UTF8 option name")?;
            if ![
                "--directory",
                "--product",
                "--component",
                "--version",
                "--os",
                "--arch",
                "--oci-arch",
                "--expected-sha256",
                "--source-sha",
                "--release-source-sha",
                "--dest",
            ]
            .contains(&key.as_str())
            {
                return Err(format!("unknown option: {key}"));
            }
            let value = args
                .next()
                .ok_or_else(|| format!("missing value for {key}"))?;
            if value.is_empty() {
                return Err(format!("empty value for {key}"));
            }
            if values.insert(key.clone(), value).is_some() {
                return Err(format!("duplicate option: {key}"));
            }
        }
        let mut required = |key: &str| {
            values
                .remove(key)
                .ok_or_else(|| format!("required option: {key}"))
        };
        let directory = PathBuf::from(required("--directory")?);
        let destination = PathBuf::from(required("--dest")?);
        let mut text = |key: &str| {
            required(key)?
                .into_string()
                .map_err(|_| format!("non-UTF8 value for {key}"))
        };
        let product = text("--product")?;
        let component = text("--component")?;
        let version = text("--version")?;
        let os = text("--os")?;
        let arch = text("--arch")?;
        let oci_arch = text("--oci-arch")?;
        if product != "happier-server"
            || component != "happier-server-light"
            || os != "linux"
            || arch != "x64"
            || oci_arch != "amd64"
        {
            return Err("unsupported product/component/OS/architecture tuple".into());
        }
        if !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
            || !version.bytes().next().unwrap().is_ascii_digit()
        {
            return Err("version must be a filename-safe version beginning with a digit".into());
        }
        let digest = hex(text("--expected-sha256")?, 64, "SHA256")?;
        let source = hex(text("--source-sha")?, 40, "source SHA")?;
        if source != hex(text("--release-source-sha")?, 40, "release source SHA")? {
            return Err("source SHA differs from release source SHA".into());
        }
        if destination.file_name().is_none() || destination.parent().is_none() {
            return Err("--dest must name a disposable directory, not a filesystem root".into());
        }
        Ok(Self {
            directory,
            archive: format!("{product}-v{version}-{os}-{arch}.tar.gz"),
            envelope: format!("checksums-{product}-v{version}.txt"),
            digest,
            destination,
        })
    }
}

fn io_error(operation: &str, error: io::Error) -> String {
    format!("{operation}: {error}")
}

fn successful(output: Output, operation: &str) -> Result<Vec<u8>> {
    if !output.status.success() {
        // Retain complete child output; an exit failure must not hide its real diagnostics.
        io::stdout()
            .write_all(&output.stdout)
            .map_err(|error| io_error("write child stdout", error))?;
        io::stderr()
            .write_all(&output.stderr)
            .map_err(|error| io_error("write child stderr", error))?;
        return Err(format!("{operation}: child ended with {}", output.status));
    }
    io::stderr()
        .write_all(&output.stderr)
        .map_err(|error| io_error("write child stderr", error))?;
    Ok(output.stdout)
}

fn checked(command: &mut Command, operation: &str) -> Result<Vec<u8>> {
    let output = command.output().map_err(|error| {
        format!("{operation}: spawn/wait/output failed; child terminal unavailable: {error}")
    })?;
    successful(output, operation)
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(parent: &Path) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = parent.join(format!(
                ".relay-ingest-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error("create private scratch", error)),
            }
        }
    }

    fn close(&mut self) -> Result<()> {
        if !self.0.as_os_str().is_empty() {
            fs::remove_dir_all(&self.0)
                .map_err(|error| io_error("private scratch cleanup incomplete", error))?;
            self.0.clear();
        }
        Ok(())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("[relay-artifact] {error}");
        }
    }
}

fn snapshot(source: &Path, destination: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| io_error("open input metadata", error))?;
    if !metadata.is_file() {
        return Err(format!(
            "open input: not a regular file: {}",
            source.display()
        ));
    }
    let mut input = File::open(source).map_err(|error| io_error("open input", error))?;
    if !input
        .metadata()
        .map_err(|error| io_error("open input metadata", error))?
        .is_file()
    {
        return Err("open input: opened handle is not a regular file".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error("create private input", error))?;
    io::copy(&mut input, &mut output).map_err(|error| io_error("copy private input", error))?;
    Ok(())
}

fn checksum(archive: &Path) -> Result<String> {
    let output = match Command::new("sha256sum").arg(archive).output() {
        Ok(output) => successful(output, "archive SHA256")?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => checked(
            Command::new("shasum").args(["-a", "256"]).arg(archive),
            "archive SHA256",
        )?,
        Err(error) => {
            return Err(io_error(
                "archive SHA256 spawn/wait/output; terminal unavailable",
                error,
            ))
        }
    };
    let value = String::from_utf8(output).map_err(|_| "archive SHA256 output is not UTF8")?;
    hex(
        value.split_whitespace().next().unwrap_or("").into(),
        64,
        "archive SHA256",
    )
}

fn remove_appledouble(directory: &Path) -> Result<()> {
    for entry in
        fs::read_dir(directory).map_err(|error| io_error("read extracted directory", error))?
    {
        let entry = entry.map_err(|error| io_error("read extracted entry", error))?;
        let kind = entry
            .file_type()
            .map_err(|error| io_error("read extracted file type", error))?;
        if kind.is_dir() {
            remove_appledouble(&entry.path())?;
        } else if kind.is_file() && entry.file_name().to_string_lossy().starts_with("._") {
            fs::remove_file(entry.path())
                .map_err(|error| io_error("remove extracted AppleDouble", error))?;
        }
    }
    Ok(())
}

fn ingest(input: LocalArtifact) -> Result<()> {
    let parent = input.destination.parent().unwrap();
    let mut scratch = Scratch::new(parent)?;
    let outcome = (|| {
        let archive = scratch.0.join(&input.archive);
        let envelope = scratch.0.join(&input.envelope);
        snapshot(&input.directory.join(&input.archive), &archive)?;
        snapshot(&input.directory.join(&input.envelope), &envelope)?;
        let expected = checked(
            Command::new("awk")
                .arg("-v")
                .arg(format!("name={}", input.archive))
                .arg("$2 == name { print $1; found = 1; exit } END { if (!found) exit 42 }")
                .arg(&envelope),
            "checksum entry",
        )?;
        let expected = String::from_utf8(expected).map_err(|_| "checksum entry is not UTF8")?;
        let expected = hex(expected.trim().into(), 64, "checksum entry SHA256")?;
        let actual = checksum(&archive)?;
        if actual != expected || actual != input.digest {
            return Err(
                "archive digest mismatch with checksum envelope or required outer digest".into(),
            );
        }

        let extraction = scratch.0.join("extracted");
        fs::create_dir(&extraction)
            .map_err(|error| io_error("create private extraction directory", error))?;
        let help = checked(Command::new("tar").arg("--help"), "tar help")?;
        let help = String::from_utf8(help).map_err(|_| "tar help is not UTF8")?;
        let mut tar = Command::new("tar");
        tar.arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&extraction)
            .args([
                "-p",
                "--strip-components=1",
                "--exclude=._*",
                "--exclude=*/._*",
            ])
            .env("COPYFILE_DISABLE", "1");
        if help.contains("bsdtar") {
            tar.args(["--no-mac-metadata", "--no-xattrs"]);
        } else if help.contains("--no-mac-metadata") {
            tar.arg("--no-mac-metadata");
            if help.contains("--no-xattrs") {
                tar.arg("--no-xattrs");
            }
        }
        checked(&mut tar, "tar extraction")?;
        remove_appledouble(&extraction)?;
        match fs::symlink_metadata(&input.destination) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&input.destination)
                .map_err(|error| io_error("replace disposable destination", error))?,
            Ok(_) => return Err("destination is not a disposable directory".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(io_error("inspect disposable destination", error)),
        }
        fs::rename(extraction, &input.destination)
            .map_err(|error| io_error("publish extracted destination", error))
    })();
    let cleanup = scratch.close();
    match (outcome, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

fn main() {
    if let Err(error) = LocalArtifact::parse(std::env::args_os().skip(1)).and_then(ingest) {
        eprintln!("[relay-artifact] {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    const ARCHIVE: &str = "happier-server-v0.2.17-linux-x64.tar.gz";
    const ENVELOPE: &str = "checksums-happier-server-v0.2.17.txt";
    const SOURCE: &str = "6f467e05aac371b53e513c48b58260e7e90a88f5";

    struct Fixture {
        root: PathBuf,
        inputs: PathBuf,
        dest: PathBuf,
        digest: String,
    }

    fn checked(command: &mut Command) -> Output {
        let output = command.output().expect("spawn fixture boundary");
        assert!(output.status.success(), "{command:?}: {output:?}");
        output
    }

    fn hash(path: &Path) -> String {
        let output = checked(Command::new("sha256sum").arg(path));
        String::from_utf8(output.stdout)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .into()
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "relay-ingest-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let inputs = root.join("inputs");
            let payload = root.join("payload");
            let dest = root.join("dest");
            fs::create_dir(&inputs).unwrap();
            fs::create_dir(&payload).unwrap();
            fs::create_dir(&dest).unwrap();
            fs::write(dest.join("sentinel"), b"original destination").unwrap();
            fs::create_dir(payload.join("server")).unwrap();
            fs::create_dir(payload.join("server/nested")).unwrap();
            fs::write(payload.join("server/happier-server"), b"fixture payload").unwrap();
            fs::write(payload.join("server/._metadata"), b"metadata").unwrap();
            fs::write(payload.join("server/nested/._metadata"), b"metadata").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    payload.join("server/happier-server"),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
            checked(
                Command::new("tar")
                    .args(["-czf"])
                    .arg(inputs.join(ARCHIVE))
                    .arg("-C")
                    .arg(&payload)
                    .arg("server")
                    .env("COPYFILE_DISABLE", "1"),
            );
            let digest = hash(&inputs.join(ARCHIVE));
            fs::write(inputs.join(ENVELOPE), format!("{digest}  {ARCHIVE}\n")).unwrap();
            Self {
                root,
                inputs,
                dest,
                digest,
            }
        }

        fn args(&self) -> Vec<String> {
            vec![
                "--directory".into(),
                self.inputs.to_str().unwrap().into(),
                "--product".into(),
                "happier-server".into(),
                "--component".into(),
                "happier-server-light".into(),
                "--version".into(),
                "0.2.17".into(),
                "--os".into(),
                "linux".into(),
                "--arch".into(),
                "x64".into(),
                "--oci-arch".into(),
                "amd64".into(),
                "--expected-sha256".into(),
                self.digest.clone(),
                "--source-sha".into(),
                SOURCE.into(),
                "--release-source-sha".into(),
                SOURCE.into(),
                "--dest".into(),
                self.dest.to_str().unwrap().into(),
            ]
        }

        fn command(&self) -> Command {
            let binary = PathBuf::from(
                std::env::var_os("HAPPIER_RELAY_INGEST_BINARY")
                    .expect("set HAPPIER_RELAY_INGEST_BINARY to the compiled CLI"),
            );
            if binary
                .extension()
                .is_some_and(|extension| extension == "sh")
            {
                // The unchanged predecessor is invoked through its real shell boundary for RED.
                let mut command = Command::new("sh");
                command.arg(binary);
                command
            } else {
                Command::new(binary)
            }
        }

        fn refuse(&self, args: &[String], expected: &str) {
            let output = self.command().args(args).output().unwrap();
            assert!(!output.status.success(), "accepted invalid input: {args:?}");
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert!(stderr.contains(expected), "expected {expected:?}: {stderr}");
            assert_eq!(
                fs::read(self.dest.join("sentinel")).unwrap(),
                b"original destination"
            );
            assert!(!fs::read_dir(&self.root).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".relay-ingest-")));
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).expect("fixture cleanup must be complete");
        }
    }

    #[test]
    fn local_ingress_uses_only_selected_pair_and_preserves_payload() {
        let fixture = Fixture::new();
        fs::write(
            fixture.inputs.join("happier-server-v9-linux-x64.tar.gz"),
            b"unrelated archive",
        )
        .unwrap();
        let output = checked(fixture.command().args(fixture.args()));
        assert!(output.stderr.is_empty(), "{output:?}");
        assert_eq!(
            fs::read(fixture.dest.join("happier-server")).unwrap(),
            b"fixture payload"
        );
        assert!(!fixture.dest.join("sentinel").exists());
        assert!(!fixture.dest.join("._metadata").exists());
        assert!(!fixture.dest.join("nested/._metadata").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(fixture.dest.join("happier-server"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
    }

    #[test]
    fn local_ingress_does_not_require_remote_tools_or_key() {
        let fixture = Fixture::new();
        let bin = fixture.root.join("local-bin");
        fs::create_dir(&bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            for name in ["awk", "sha256sum", "tar", "gzip"] {
                let output =
                    checked(Command::new("sh").args(["-c", "command -v \"$1\"", "tool", name]));
                let tool = String::from_utf8(output.stdout).unwrap();
                symlink(tool.trim(), bin.join(name)).unwrap();
            }
        }
        checked(fixture.command().args(fixture.args()).env("PATH", &bin));
        assert_eq!(
            fs::read(fixture.dest.join("happier-server")).unwrap(),
            b"fixture payload"
        );
    }

    #[test]
    fn malformed_or_partial_tuples_refuse_before_replacement() {
        let fixture = Fixture::new();
        for (key, value, expected) in [
            ("--arch", "arm64", "unsupported"),
            ("--oci-arch", "arm64", "unsupported"),
            ("--os", "darwin", "unsupported"),
            ("--product", "happier", "unsupported"),
            ("--component", "happier-server", "unsupported"),
            ("--version", "../escape", "version"),
            ("--version", "", "empty"),
            ("--dest", "/", "filesystem root"),
            ("--expected-sha256", "bad", "SHA256"),
            ("--source-sha", "bad", "source"),
            (
                "--release-source-sha",
                "0000000000000000000000000000000000000000",
                "source",
            ),
        ] {
            let mut args = fixture.args();
            let index = args.iter().position(|arg| arg == key).unwrap();
            args[index + 1] = value.into();
            fixture.refuse(&args, expected);
        }
        let mut args = fixture.args();
        args.truncate(args.len() - 2);
        fixture.refuse(&args, "--dest");
        let mut args = fixture.args();
        args.push("--directory".into());
        args.push("duplicate".into());
        fixture.refuse(&args, "duplicate");
        let mut args = fixture.args();
        args.push("--unknown".into());
        fixture.refuse(&args, "unknown");
    }

    #[test]
    fn required_outer_digest_cannot_be_replaced_by_envelope() {
        let fixture = Fixture::new();
        let mut args = fixture.args();
        let index = args
            .iter()
            .position(|arg| arg == "--expected-sha256")
            .unwrap();
        args[index + 1] = "0".repeat(64);
        fixture.refuse(&args, "digest mismatch");
    }

    #[test]
    fn envelope_and_archive_refusals_preserve_destination() {
        let fixture = Fixture::new();
        fs::write(
            fixture.inputs.join(ENVELOPE),
            format!("{}  {ARCHIVE}\n", "0".repeat(64)),
        )
        .unwrap();
        fixture.refuse(&fixture.args(), "digest mismatch");
        fs::write(
            fixture.inputs.join(ENVELOPE),
            format!("{}  wrong-target.tar.gz\n", fixture.digest),
        )
        .unwrap();
        fixture.refuse(&fixture.args(), "checksum entry");
        fs::remove_file(fixture.inputs.join(ENVELOPE)).unwrap();
        fixture.refuse(&fixture.args(), "open input");
        fs::remove_file(fixture.inputs.join(ARCHIVE)).unwrap();
        fixture.refuse(&fixture.args(), "open input");
    }

    #[test]
    fn extraction_failure_preserves_destination_and_cleans_scratch() {
        let mut fixture = Fixture::new();
        fs::write(fixture.inputs.join(ARCHIVE), b"not a tar archive").unwrap();
        fixture.digest = hash(&fixture.inputs.join(ARCHIVE));
        fs::write(
            fixture.inputs.join(ENVELOPE),
            format!("{}  {ARCHIVE}\n", fixture.digest),
        )
        .unwrap();
        fixture.refuse(&fixture.args(), "tar extraction");
    }

    #[test]
    fn missing_local_tool_reports_failure_without_replacing_destination() {
        let fixture = Fixture::new();
        let bin = fixture.root.join("empty-bin");
        fs::create_dir(&bin).unwrap();
        let output = fixture
            .command()
            .args(fixture.args())
            .env("PATH", &bin)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("checksum entry: spawn/wait/output failed"));
        assert_eq!(
            fs::read(fixture.dest.join("sentinel")).unwrap(),
            b"original destination"
        );
        assert!(!fs::read_dir(&fixture.root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".relay-ingest-")));
    }

    #[test]
    #[cfg(unix)]
    fn nonregular_input_and_destination_are_refused() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let original = fixture.root.join("archive");
        fs::rename(fixture.inputs.join(ARCHIVE), &original).unwrap();
        symlink(&original, fixture.inputs.join(ARCHIVE)).unwrap();
        fixture.refuse(&fixture.args(), "not a regular file");
        fs::remove_file(fixture.inputs.join(ARCHIVE)).unwrap();
        fs::rename(original, fixture.inputs.join(ARCHIVE)).unwrap();
        let target = fixture.root.join("existing-file");
        fs::write(&target, b"preserve file").unwrap();
        let mut args = fixture.args();
        let index = args.iter().position(|arg| arg == "--dest").unwrap();
        args[index + 1] = target.to_str().unwrap().into();
        fixture.refuse(&args, "not a disposable directory");
        assert_eq!(fs::read(target).unwrap(), b"preserve file");
    }

    #[test]
    #[cfg(unix)]
    fn unchanged_signed_owner_refuses_failed_signature_before_replacement() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let bin = fixture.root.join("signature-bin");
        fs::create_dir(&bin).unwrap();
        let false_path = checked(Command::new("sh").args(["-c", "command -v false"]));
        let false_path = String::from_utf8(false_path.stdout).unwrap();
        // A real process failure at the signature boundary; no signing key or network.
        // Resolve the external executable rather than a shell's builtin `false`.
        let executable = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join(false_path.trim()))
            .find(|path| path.is_file())
            .unwrap();
        symlink(executable, bin.join("minisign")).unwrap();
        fs::write(
            fixture.inputs.join(format!("{ENVELOPE}.minisig")),
            b"fixture signature",
        )
        .unwrap();
        let key = fixture.root.join("public-key");
        fs::write(&key, b"fixture public key").unwrap();
        let path = std::env::join_paths(
            std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        let output = Command::new("sh")
            .arg(Path::new(file!()).with_file_name("fetch-verified-release-artifact.sh"))
            .arg("--base-url")
            .arg(format!("file://{}", fixture.root.display()))
            .args([
                "--release-tag",
                "inputs",
                "--product",
                "happier-server",
                "--version",
                "0.2.17",
                "--os",
                "linux",
                "--arch",
                "x64",
                "--dest",
            ])
            .arg(&fixture.dest)
            .arg("--pubkey")
            .arg(key)
            .env("PATH", path)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        assert_eq!(
            fs::read(fixture.dest.join("sentinel")).unwrap(),
            b"original destination"
        );
    }

    #[test]
    fn docker_selection_keeps_signed_default_and_runtime_contract() {
        let dockerfile = include_str!("../../../Dockerfile");
        assert!(dockerfile.contains("ARG HAPPIER_RELAY_ARTIFACT_MODE=signed"));
        assert!(dockerfile
            .contains("FROM relay-artifacts-${HAPPIER_RELAY_ARTIFACT_MODE} AS relay-artifacts"));
        let signed = dockerfile
            .split("AS relay-artifacts-signed\n")
            .nth(1)
            .unwrap()
            .split("\nFROM ")
            .next()
            .unwrap();
        assert!(signed.contains("fetch-verified-release-artifact"));
        assert!(!signed.contains("ingest-local-relay-artifact"));
        assert!(!signed.contains("--from=relay-local-ingest-builder"));
        let local = dockerfile
            .split("AS relay-artifacts-local\n")
            .nth(1)
            .unwrap()
            .split("\nFROM ")
            .next()
            .unwrap();
        assert!(local.contains("--mount=type=bind,target=/context,readonly"));
        assert!(!local.contains("fetch-verified-release-artifact"));
        assert!(!local.contains("minisign"));
        let common = dockerfile
            .split(" AS relay-artifacts\n")
            .nth(1)
            .unwrap()
            .split("\nFROM ")
            .next()
            .unwrap();
        assert!(common.contains(
            "rm -rf /opt/happier/server/generated/mysql-client /opt/happier/server/prisma/mysql"
        ));
        assert!(common.contains("libquery_engine-debian-openssl-3.0.x.so.node"));
        let runtime = dockerfile
            .split("FROM debian:12-slim AS relay-server\n")
            .nth(1)
            .unwrap();
        let original = include_str!("../../../apps/server/scripts/run-server.sh");
        assert!(runtime.contains("COPY --from=relay-artifacts --chown=happier:happier /opt/happier/server /opt/happier/server"));
        assert!(runtime.contains("CMD [\"run-server\", \"/opt/happier/server/happier-server\"]"));
        assert!(original.contains("exec \"$server_binary\""));
    }
}
