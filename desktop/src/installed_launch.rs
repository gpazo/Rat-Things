use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub enum Script {
    Console,
    Cli,
}

pub struct InstalledLaunch {
    pub bundle: PathBuf,
    pub node: PathBuf,
    pub script: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

pub fn plan(
    executable: &Path,
    script: Script,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<InstalledLaunch, String> {
    let executable = executable
        .canonicalize()
        .map_err(|_| "The installed executable is missing")?;
    let macos = executable
        .parent()
        .ok_or("The installed executable has no directory")?;
    let contents = macos
        .parent()
        .ok_or("The installed app has no Contents directory")?;
    let bundle = contents
        .parent()
        .ok_or("The installed app has no bundle directory")?;
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || bundle
            .extension()
            .is_none_or(|extension| extension != "app")
    {
        return Err("Run the installed Rat Things app or its bundled command-line launcher".into());
    }
    let script = contents.join("Resources").join(match script {
        Script::Console => "console-server.mjs",
        Script::Cli => "cli.mjs",
    });
    let node = macos.join("node");
    for directory in [
        macos,
        contents,
        &contents.join("Resources"),
        &contents.join("Helpers"),
    ] {
        require_type(directory, true)?;
    }
    for file in [
        &executable,
        &node,
        &script,
        &contents.join("Helpers/rat-runtime-verifier"),
        &contents.join("Helpers/rat-native-recovery"),
    ] {
        require_type(file, false)?;
    }
    require_type(&contents.join("Resources/Runtime.bundle"), true)?;
    Ok(InstalledLaunch {
        bundle: bundle.to_path_buf(),
        node,
        script,
        environment: environment(inherited)?,
    })
}

pub fn environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<BTreeMap<OsString, OsString>, String> {
    let allowed = [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "RAT_THINGS_LOCAL_DIR",
        "RAT_THINGS_MODEL",
        "RAT_THINGS_CONSOLE_PORT",
        "RAT_THINGS_AGENTS_API_URL",
        "AGENTS_API_BASE_URL",
        "RAT_THINGS_API_URL",
        "AGENT_RUNTIME_API_URL",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SDK_LOAD_CONFIG",
        "AWS_CA_BUNDLE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    let forbidden = [
        "RAT_THINGS_CONSOLE_SERVER",
        "RAT_THINGS_CONSOLE_NODE",
        "RAT_THINGS_CONSOLE_BIN",
        "CODEX_BINARY",
    ];
    let mut result = BTreeMap::new();
    for (key, value) in inherited {
        let Some(name) = key.to_str() else { continue };
        if forbidden.contains(&name) || name.starts_with("RAT_NATIVE_") {
            return Err(format!(
                "The installed app does not accept the executable override {name}"
            ));
        }
        if allowed.contains(&name) {
            result.insert(key, value);
        }
    }
    result.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
    Ok(result)
}

pub fn verify_bundle(bundle: &Path) -> Result<(), String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("The installed native runtime requires an Apple silicon Mac".into());
    }
    let mut child = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--all-architectures", "--test-requirement",
            "=anchor apple generic and certificate leaf[subject.OU] = \"PB8NAVKU57\" and identifier \"dev.rat-things.console\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"])
        .arg(bundle).env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|_| "Could not verify the installed Rat Things app")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err("The installed Rat Things app signature is invalid".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The installed Rat Things app could not be verified in time".into());
            }
        }
    }
}

fn require_type(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|_| "The installed Rat Things app is incomplete")?;
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err("The installed Rat Things app has an invalid resource".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_data_and_aws_configuration_but_drops_code_injection() {
        let input = [
            ("HOME", "/home/fixture"),
            ("AWS_PROFILE", "development"),
            ("RAT_THINGS_LOCAL_DIR", "/data"),
            ("NODE_OPTIONS", "--import=/untrusted.mjs"),
            ("NODE_PATH", "/untrusted"),
            ("DYLD_INSERT_LIBRARIES", "/untrusted.dylib"),
            ("AGENT_RUNTIME_UNSIGNED", "true"),
            ("CODEX_HOME", "/personal"),
            ("CODEX_API_KEY", "billing"),
            ("OPENAI_API_KEY", "billing"),
            ("PATH", "/untrusted"),
        ];
        let result = environment(input.map(|(key, value)| (key.into(), value.into()))).unwrap();
        assert_eq!(result.len(), 4);
        assert_eq!(
            result.get(&OsString::from("AWS_PROFILE")),
            Some(&OsString::from("development"))
        );
        assert_eq!(
            result.get(&OsString::from("PATH")),
            Some(&OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
        );
    }

    #[test]
    fn rejects_development_executable_overrides_even_when_empty() {
        for name in [
            "CODEX_BINARY",
            "RAT_THINGS_CONSOLE_SERVER",
            "RAT_THINGS_CONSOLE_NODE",
            "RAT_THINGS_CONSOLE_BIN",
            "RAT_NATIVE_VM_PROOF",
            "RAT_NATIVE_SOURCE_IMAGE",
        ] {
            assert!(environment([(name.into(), "".into())]).is_err());
        }
    }

    #[test]
    fn derives_both_scripts_from_the_running_app_and_rejects_linked_payloads() {
        let directory =
            std::env::temp_dir().join(format!("rat-installed-launch-{}", std::process::id()));
        let contents = directory.join("Rat Things.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Resources/Runtime.bundle")).unwrap();
        std::fs::create_dir_all(contents.join("Helpers")).unwrap();
        for path in [
            "MacOS/rat-things-desktop",
            "MacOS/node",
            "Resources/console-server.mjs",
            "Resources/cli.mjs",
            "Helpers/rat-runtime-verifier",
            "Helpers/rat-native-recovery",
        ] {
            std::fs::write(contents.join(path), "fixture").unwrap();
        }
        let executable = contents.join("MacOS/rat-things-desktop");
        for (script, name) in [
            (Script::Console, "console-server.mjs"),
            (Script::Cli, "cli.mjs"),
        ] {
            let launch = plan(&executable, script, []).unwrap();
            assert_eq!(launch.script.file_name().unwrap(), name);
            assert_eq!(launch.node.file_name().unwrap(), "node");
            assert_eq!(launch.bundle.file_name().unwrap(), "Rat Things.app");
            assert!(launch.environment.contains_key(&OsString::from("PATH")));
        }
        assert!(plan(&contents.join("Resources/cli.mjs"), Script::Cli, []).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_file(contents.join("MacOS/node")).unwrap();
            std::os::unix::fs::symlink(&executable, contents.join("MacOS/node")).unwrap();
            assert!(plan(&executable, Script::Console, []).is_err());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
