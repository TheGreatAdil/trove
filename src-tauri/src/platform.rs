//! Which OS, and which version of it, Trove is running on. The page uses it
//! to match the window's own corner radius. It is handed over before any of
//! the page's scripts run, as `window.__TROVE_OS__`.

use serde::Serialize;

#[derive(Serialize)]
pub struct Os {
    /// "windows", "macos", "linux", …
    name: &'static str,
    /// The version people know it by: 10 or 11 on Windows; 15, 26, 27… on
    /// macOS. 0 when it isn't known.
    version: u32,
}

#[cfg(windows)]
fn current() -> Os {
    // Windows 11 still reports itself as 10.0; its build numbers start at 22000.
    let v = windows_version::OsVersion::current();
    let version = if v.major == 10 && v.build >= 22000 { 11 } else { v.major };
    Os { name: "windows", version }
}

#[cfg(target_os = "macos")]
fn current() -> Os {
    // sw_vers reports the real version. Asked from inside an app built with an
    // older SDK, macOS 26 can call itself 16, so 16 is read as 26.
    let major = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|v| v.trim().split('.').next()?.parse().ok())
        .unwrap_or(0);
    Os { name: "macos", version: if major == 16 { 26 } else { major } }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn current() -> Os {
    Os { name: std::env::consts::OS, version: 0 }
}

/// A script that runs at the start of every page load.
pub fn init_script() -> String {
    let os = serde_json::to_string(&current()).unwrap_or_else(|_| "null".into());
    format!("window.__TROVE_OS__ = {os};")
}

#[cfg(test)]
mod tests {
    #[test]
    fn script_names_this_os() {
        let script = super::init_script();
        assert!(script.starts_with("window.__TROVE_OS__ = {\"name\":\""), "{script}");
        assert!(script.contains(std::env::consts::OS), "{script}");
        #[cfg(windows)]
        assert!(script.contains("\"version\":10") || script.contains("\"version\":11"), "{script}");
    }
}
