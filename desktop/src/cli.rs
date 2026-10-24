use rat_things_desktop::installed_launch::{Script, plan, verify_bundle};
use std::process::Command;

fn run() -> Result<(), String> {
    let launch = plan(
        &std::env::current_exe().map_err(|error| error.to_string())?,
        Script::Cli,
        std::env::vars_os(),
    )?;
    verify_bundle(&launch.bundle)?;
    let mut command = Command::new(launch.node);
    command
        .arg(launch.script)
        .args(std::env::args_os().skip(1))
        .env_clear()
        .envs(launch.environment);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec().to_string())
    }
    #[cfg(not(unix))]
    {
        let status = command.status().map_err(|error| error.to_string())?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Rat Things: {error}");
        std::process::exit(1);
    }
}
