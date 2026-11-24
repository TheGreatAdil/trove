mod project;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

type CmdResult<T> = Result<T, String>;

/// The open project's working directory. Images are unpacked here while the
/// project is open and shown through the asset protocol.
#[derive(Default)]
struct Session {
    dir: Option<PathBuf>,
}

/// A `.trv` the OS asked us to open (double-click, "Open with", second
/// instance). Held until the frontend is ready to receive it.
#[derive(Default)]
struct Launch {
    ready: bool,
    pending: Option<PathBuf>,
}

#[derive(Serialize)]
struct Opened {
    dir: String,
    manifest: Option<Value>,
}

#[derive(Serialize)]
struct Saved {
    path: String,
    missing: usize,
}

fn sessions_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("sessions"))
}

fn create_session_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let dir = sessions_root(app)?.join(format!("{stamp:x}"));
    std::fs::create_dir_all(project::images_dir(&dir)).map_err(|e| format!("Couldn't create a working folder: {e}"))?;
    Ok(dir)
}

/// Makes `dir` the current session and removes every other session folder,
/// including ones left behind by a crash. Only one instance ever runs.
fn switch_session(app: &AppHandle, dir: PathBuf) {
    app.state::<Mutex<Session>>().lock().unwrap().dir = Some(dir.clone());
    if let Ok(entries) = sessions_root(app).and_then(|root| std::fs::read_dir(root).map_err(|e| e.to_string())) {
        for entry in entries.flatten() {
            if entry.path() != dir {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn current_session(state: &Mutex<Session>) -> CmdResult<PathBuf> {
    state.lock().unwrap().dir.clone().ok_or_else(|| "No project is open.".into())
}

fn trv_path(path: &str) -> CmdResult<PathBuf> {
    let path = PathBuf::from(path);
    if project::has_extension(&path) {
        Ok(path)
    } else {
        Err("Trove projects use the .trv extension.".into())
    }
}

fn image_path(state: &Mutex<Session>, name: &str) -> CmdResult<PathBuf> {
    if !project::is_safe_name(name) {
        return Err(format!("Invalid image name: {name}"));
    }
    Ok(project::images_dir(&current_session(state)?).join(name))
}

/// Starts an empty, unsaved project.
#[tauri::command]
async fn project_new(app: AppHandle) -> CmdResult<Opened> {
    let dir = create_session_dir(&app)?;
    switch_session(&app, dir.clone());
    Ok(Opened { dir: dir.display().to_string(), manifest: None })
}

/// Opens a `.trv`. The current project stays open if this fails.
#[tauri::command]
async fn project_open(app: AppHandle, path: String) -> CmdResult<Opened> {
    let path = trv_path(&path)?;
    let dir = create_session_dir(&app)?;
    match project::extract(&path, &dir) {
        Ok(manifest) => {
            switch_session(&app, dir.clone());
            Ok(Opened { dir: dir.display().to_string(), manifest: Some(manifest) })
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Saves the open project to `path`, adding `.trv` if it's missing.
#[tauri::command]
async fn project_save(state: State<'_, Mutex<Session>>, path: String, manifest: Value) -> CmdResult<Saved> {
    let mut path = PathBuf::from(path);
    if !project::has_extension(&path) {
        let mut with_ext = path.into_os_string();
        with_ext.push(".");
        with_ext.push(project::EXTENSION);
        path = PathBuf::from(with_ext);
    }
    let missing = project::write(&path, &manifest, &current_session(&state)?)?;
    Ok(Saved { path: path.display().to_string(), missing })
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or_default()
}

/// Sidebar summaries (count, last update, cover thumbnail) for saved boards.
#[tauri::command]
async fn library_info(app: AppHandle, paths: Vec<String>) -> CmdResult<Vec<project::Info>> {
    let thumbs = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    Ok(paths
        .iter()
        .map(|p| match trv_path(p) {
            Ok(path) => project::info(&path, &thumbs),
            Err(e) => project::Info { path: p.clone(), error: Some(e), ..Default::default() },
        })
        .collect())
}

/// Renames a board's file to match its new name. Returns the new path.
#[tauri::command]
async fn project_rename(path: String, name: String) -> CmdResult<String> {
    let from = trv_path(&path)?;
    let stem = project::file_stem_for(&name)?;
    let to = from.with_file_name(format!("{stem}.{}", project::EXTENSION));
    if to == from {
        return Ok(path);
    }
    let only_case_changed = to.to_string_lossy().to_lowercase() == from.to_string_lossy().to_lowercase();
    if to.exists() && !only_case_changed {
        return Err(format!("There's already a board called “{stem}” in that folder."));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Couldn't rename the board: {e}"))?;
    Ok(to.display().to_string())
}

/// Adds items from the open board to another, saved board (drag onto a board
/// in the sidebar). Their images are copied from the open board's folder.
#[tauri::command]
async fn project_add_items(state: State<'_, Mutex<Session>>, path: String, items: Vec<Value>) -> CmdResult<()> {
    let path = trv_path(&path)?;
    let session = current_session(&state)?;
    let now = now_ms();
    project::update(&path, &session, |m| {
        if !m["items"].is_array() {
            m["items"] = Value::Array(Vec::new());
        }
        let list = m["items"].as_array_mut().expect("items is an array");
        for item in items {
            if !list.iter().any(|i| i.get("id").is_some() && i.get("id") == item.get("id")) {
                list.push(item);
            }
        }
        m["updatedAt"] = Value::from(now);
    })
}

/// Takes items back out of a saved board (undoing a move).
#[tauri::command]
async fn project_remove_items(state: State<'_, Mutex<Session>>, path: String, ids: Vec<String>) -> CmdResult<()> {
    let path = trv_path(&path)?;
    let session = current_session(&state)?;
    let now = now_ms();
    project::update(&path, &session, |m| {
        if let Some(list) = m["items"].as_array_mut() {
            list.retain(|i| !i.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|x| x == id)));
        }
        m["updatedAt"] = Value::from(now);
    })
}

/// Moves a `.trv` to the Recycle Bin / Trash, so a delete can be undone there.
#[tauri::command]
async fn project_delete(path: String) -> CmdResult<()> {
    let path = trv_path(&path)?;
    trash::delete(&path).map_err(|e| format!("Couldn't move the project to the trash: {e}"))
}

/// Writes an image into the open project. The body is the raw image bytes and
/// the `x-file` header carries the generated file name.
#[tauri::command]
async fn image_put(request: Request<'_>, state: State<'_, Mutex<Session>>) -> CmdResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected image bytes.".into());
    };
    let name = request
        .headers()
        .get("x-file")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing image name.")?;
    std::fs::write(image_path(&state, name)?, bytes).map_err(|e| format!("Couldn't store the image: {e}"))
}

/// Reads an image from the open project (used for copying to the clipboard).
#[tauri::command]
async fn image_read(state: State<'_, Mutex<Session>>, file: String) -> CmdResult<Response> {
    let bytes = std::fs::read(image_path(&state, &file)?).map_err(|e| format!("Couldn't read the image: {e}"))?;
    Ok(Response::new(bytes))
}

/// Called once by the frontend when it has booted. Returns the `.trv` the app
/// was launched with, if any; later requests arrive as `open-project` events.
#[tauri::command]
fn take_launch_path(launch: State<'_, Mutex<Launch>>) -> Option<String> {
    let mut launch = launch.lock().unwrap();
    launch.ready = true;
    launch.pending.take().map(|p| p.display().to_string())
}

fn find_trv(args: impl IntoIterator<Item = PathBuf>, cwd: &Path) -> Option<PathBuf> {
    args.into_iter()
        .find(|p| project::has_extension(p))
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) })
}

fn open_from_os(app: &AppHandle, path: PathBuf) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let state = app.state::<Mutex<Launch>>();
    let mut launch = state.lock().unwrap();
    if launch.ready {
        let _ = app.emit("open-project", path.display().to_string());
    } else {
        launch.pending = Some(path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let launch_path = find_trv(std::env::args_os().skip(1).map(PathBuf::from), &cwd);

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Must be registered first. A second launch (e.g. double-clicking another
    // .trv) hands its arguments to the running app and exits.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args = argv.into_iter().skip(1).map(PathBuf::from);
            match find_trv(args, Path::new(&cwd)) {
                Some(path) => open_from_os(app, path),
                None => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(Session::default()))
        .manage(Mutex::new(Launch { ready: false, pending: launch_path }))
        .invoke_handler(tauri::generate_handler![
            project_new,
            project_open,
            project_save,
            project_delete,
            project_rename,
            project_add_items,
            project_remove_items,
            library_info,
            image_put,
            image_read,
            take_launch_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                if let Some(dir) = app.state::<Mutex<Session>>().lock().unwrap().dir.take() {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
            // macOS delivers "open this file" as an event instead of an argument.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok());
                if let Some(path) = find_trv(paths, Path::new("/")) {
                    open_from_os(app, path);
                }
            }
            _ => {}
        });
}
