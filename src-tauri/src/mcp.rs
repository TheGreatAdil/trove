//! A small, read-only MCP server that lets coding agents and other LLM tools
//! read Trove's boards: notes in full, image details, and the images themselves.
//!
//! It speaks the Streamable HTTP transport (JSON responses, no server-sent
//! events), listens on 127.0.0.1 only, and answers only on a path that carries
//! a secret token, so other programs and web pages can't read the boards
//! without the link.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::project;

/// Protocol versions we can speak, newest first.
const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY: u64 = 1 << 20;
/// Long edge images are scaled to by default; what vision models take without resizing.
const DEFAULT_MAX_SIZE: u32 = 1568;
/// Images bigger than this are re-encoded even if their size in pixels is fine.
const MAX_IMAGE_BYTES: usize = 3_500_000;

/// The open board as the frontend last described it. It may have unsaved changes.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenBoard {
    pub name: String,
    pub path: Option<String>,
    #[serde(default)]
    pub unsaved: bool,
    #[serde(default)]
    pub items: Vec<Value>,
}

#[derive(Default)]
pub struct Snapshot {
    pub open: Option<OpenBoard>,
    /// Every saved board in the sidebar.
    pub library: Vec<String>,
}

/// What request handlers share with the app.
pub struct Shared {
    pub snapshot: RwLock<Snapshot>,
    /// Where the open board's images are unpacked right now.
    pub session_dir: Box<dyn Fn() -> Option<PathBuf> + Send + Sync>,
}

/* ───────── boards ───────── */

enum Source {
    Session(Option<PathBuf>),
    File(PathBuf),
}

struct Board {
    id: String,
    name: String,
    file: Option<String>,
    open: bool,
    unsaved: bool,
    items: Vec<Value>,
    source: Source,
}

/// A stable short id for a saved board, from its path (FNV-1a).
fn board_id(path: &str) -> String {
    let key = if cfg!(windows) { path.to_lowercase() } else { path.to_string() };
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("b{:08x}", h as u32)
}

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
}

fn file_stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn sort_key(item: &Value) -> f64 {
    item.get("pos").and_then(Value::as_f64).or_else(|| item.get("createdAt").and_then(Value::as_f64)).unwrap_or(0.0)
}

/// Board order: newest (highest `pos`) first, as on screen.
fn in_order(mut items: Vec<Value>) -> Vec<Value> {
    items.retain(|i| i.get("id").and_then(Value::as_str).is_some());
    items.sort_by(|a, b| sort_key(b).total_cmp(&sort_key(a)));
    items
}

/// Every board an agent can see: the open one first (live), then the saved ones.
/// Saved boards that can't be read are skipped.
fn all_boards(shared: &Shared) -> Vec<Board> {
    let (open, library) = {
        let s = shared.snapshot.read().unwrap();
        (s.open.clone(), s.library.clone())
    };
    let mut boards = Vec::new();
    let open_path = open.as_ref().and_then(|o| o.path.clone());
    if let Some(o) = open {
        boards.push(Board {
            id: "open".into(),
            name: o.name,
            file: o.path,
            open: true,
            unsaved: o.unsaved,
            items: in_order(o.items),
            source: Source::Session((shared.session_dir)()),
        });
    }
    for path in library {
        if open_path.as_deref().is_some_and(|p| same_path(p, &path)) {
            continue;
        }
        let Ok(m) = project::read_manifest(Path::new(&path)) else { continue };
        let items = m.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        boards.push(Board {
            id: board_id(&path),
            name: project::board_name(&m).unwrap_or_else(|| file_stem(&path)),
            file: Some(path.clone()),
            open: false,
            unsaved: false,
            items: in_order(items),
            source: Source::File(PathBuf::from(path)),
        });
    }
    boards
}

/// Finds a board by id, name or file name (case-insensitive).
fn find_board(shared: &Shared, key: &str) -> Result<Board, String> {
    let key = key.trim();
    let mut boards = all_boards(shared);
    let lower = key.to_lowercase();
    let at = boards.iter().position(|b| b.id == key)
        .or_else(|| boards.iter().position(|b| b.name.to_lowercase() == lower))
        .or_else(|| boards.iter().position(|b| b.file.as_deref().is_some_and(|f| file_stem(f).to_lowercase() == lower || same_path(f, key))));
    match at {
        Some(i) => Ok(boards.swap_remove(i)),
        None => Err(format!("No board called “{key}”. Use list_boards to see the boards and their ids.")),
    }
}

fn is_note(item: &Value) -> bool {
    item.get("kind").and_then(Value::as_str) == Some("text")
}

fn counts(items: &[Value]) -> (usize, usize) {
    let notes = items.iter().filter(|i| is_note(i)).count();
    (notes, items.len() - notes)
}

fn summary(b: &Board) -> Value {
    let (notes, images) = counts(&b.items);
    let mut v = json!({ "id": b.id, "name": b.name, "notes": notes, "images": images });
    if let Some(f) = &b.file { v["file"] = json!(f); }
    if b.open { v["open"] = json!(true); }
    if b.unsaved { v["unsavedChanges"] = json!(true); }
    v
}

/// "2026-11-24T10:20:00Z" from milliseconds since the epoch.
fn iso_date(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn describe(item: &Value) -> Value {
    let id = item["id"].as_str().unwrap_or_default();
    let added = item.get("createdAt").and_then(Value::as_f64).map(iso_date);
    let mut v = if is_note(item) {
        json!({ "id": id, "type": "note", "text": item.get("text").and_then(Value::as_str).unwrap_or_default() })
    } else {
        let mut v = json!({ "id": id, "type": "image" });
        if let (Some(w), Some(h)) = (item.get("w").and_then(Value::as_u64), item.get("h").and_then(Value::as_u64)) {
            v["width"] = json!(w);
            v["height"] = json!(h);
        }
        if let Some(tone) = item.get("tone").and_then(Value::as_array).filter(|t| t.len() == 3) {
            let hex: String = tone.iter().map(|c| format!("{:02x}", c.as_u64().unwrap_or(0).min(255))).collect();
            v["dominantColor"] = json!(format!("#{hex}"));
        }
        let link = item.get("source").and_then(Value::as_str).or_else(|| item.get("src").and_then(Value::as_str));
        if let Some(link) = link { v["source"] = json!(link); }
        if item.get("file").is_none() { v["webLinkOnly"] = json!(true); }
        v
    };
    if let Some(added) = added { v["added"] = json!(added); }
    v
}

/* ───────── images ───────── */

fn mime_of(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Makes an image fit for a vision model: at most `max` pixels on its long edge
/// and a few megabytes, as PNG, JPEG, GIF or WebP. Small images pass through.
fn prepare(bytes: Vec<u8>, name: &str, max: u32) -> Result<(Vec<u8>, &'static str, u32, u32), String> {
    let mime = mime_of(name);
    let passable = matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp");
    let img = match image::load_from_memory(&bytes) {
        Ok(img) => img,
        Err(_) if passable && bytes.len() <= MAX_IMAGE_BYTES => return Ok((bytes, mime, 0, 0)),
        Err(e) => return Err(format!("Trove can't convert this image ({mime}): {e}")),
    };
    let (w, h) = (img.width(), img.height());
    if passable && w.max(h) <= max && bytes.len() <= MAX_IMAGE_BYTES {
        return Ok((bytes, mime, w, h));
    }
    let img = if w.max(h) > max { img.resize(max, max, FilterType::Lanczos3) } else { img };
    let mut out = Vec::new();
    let mime = if img.color().has_alpha() {
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|e| e.to_string())?;
        "image/png"
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(JpegEncoder::new_with_quality(&mut out, 85)).map_err(|e| e.to_string())?;
        "image/jpeg"
    };
    Ok((out, mime, img.width(), img.height()))
}

fn image_bytes(board: &Board, file: &str) -> Result<Vec<u8>, String> {
    if !project::is_safe_name(file) {
        return Err(format!("Invalid image name: {file}"));
    }
    match &board.source {
        Source::Session(Some(dir)) => std::fs::read(project::images_dir(dir).join(file)).map_err(|e| format!("Couldn't read the image: {e}")),
        Source::Session(None) => Err("The open board's images aren't available.".into()),
        Source::File(path) => project::read_image(path, file),
    }
}

/* ───────── tools ───────── */

fn tools() -> Value {
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false });
    json!([
        {
            "name": "list_boards",
            "title": "List boards",
            "description": "List the reference boards in Trove: the board open in the app (including unsaved changes) and every saved board in its sidebar, with how many notes and images each holds. Start here.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only
        },
        {
            "name": "get_board",
            "title": "Read a board",
            "description": "Read one board in board order (newest first): every text note in full, and for each image its id, size, dominant colour and the link it came from. Use get_image to look at an image.",
            "inputSchema": {
                "type": "object",
                "properties": { "board": { "type": "string", "description": "Board id from list_boards, or the board's name." } },
                "required": ["board"]
            },
            "annotations": read_only
        },
        {
            "name": "get_image",
            "title": "Look at an image",
            "description": "Return one image from a board so you can see it. Large images are scaled down to max_size pixels on their long edge.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board": { "type": "string", "description": "Board id from list_boards, or the board's name." },
                    "id": { "type": "string", "description": "The image's id from get_board." },
                    "max_size": { "type": "integer", "minimum": 256, "maximum": 4096, "description": "Longest edge in pixels. Defaults to 1568." }
                },
                "required": ["board", "id"]
            },
            "annotations": read_only
        },
        {
            "name": "search",
            "title": "Search notes",
            "description": "Find text notes and image links containing some text, across every board (or one board).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to look for. Case doesn't matter." },
                    "board": { "type": "string", "description": "Only search this board (id or name)." }
                },
                "required": ["query"]
            },
            "annotations": read_only
        }
    ])
}

fn text(s: impl Into<String>) -> Value {
    json!({ "type": "text", "text": s.into() })
}

fn tool_ok(content: Vec<Value>) -> Value {
    json!({ "content": content, "isError": false })
}

fn tool_err(msg: impl Into<String>) -> Value {
    json!({ "content": [text(msg)], "isError": true })
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn call_tool(shared: &Shared, params: Option<&Value>) -> Value {
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or_default();
    let empty = json!({});
    let args = params.and_then(|p| p.get("arguments")).unwrap_or(&empty);
    let result = match name {
        "list_boards" => list_boards(shared),
        "get_board" => get_board(shared, args),
        "get_image" => get_image(shared, args),
        "search" => search(shared, args),
        _ => Err(format!("Unknown tool: {name}")),
    };
    result.unwrap_or_else(tool_err)
}

fn list_boards(shared: &Shared) -> Result<Value, String> {
    let boards: Vec<Value> = all_boards(shared).iter().map(summary).collect();
    if boards.is_empty() {
        return Ok(tool_ok(vec![text("Trove has no boards open or saved yet.")]));
    }
    Ok(tool_ok(vec![text(pretty(&json!({ "boards": boards })))]))
}

fn get_board(shared: &Shared, args: &Value) -> Result<Value, String> {
    let board = find_board(shared, arg(args, "board").ok_or("Say which board: pass `board`.")?)?;
    let items: Vec<Value> = board.items.iter().map(describe).collect();
    let out = json!({ "board": summary(&board), "items": items });
    Ok(tool_ok(vec![text(pretty(&out))]))
}

fn get_image(shared: &Shared, args: &Value) -> Result<Value, String> {
    let board = find_board(shared, arg(args, "board").ok_or("Say which board: pass `board`.")?)?;
    let id = arg(args, "id").ok_or("Say which image: pass its `id` from get_board.")?;
    let item = board.items.iter().find(|i| i["id"].as_str() == Some(id)).ok_or_else(|| format!("No item {id} on “{}”.", board.name))?;
    if is_note(item) {
        return Err(format!("{id} is a text note, not an image. Its text is in get_board."));
    }
    let Some(file) = item.get("file").and_then(Value::as_str) else {
        let link = item.get("src").and_then(Value::as_str).unwrap_or("(no address)");
        return Ok(tool_ok(vec![text(format!("This image is kept as a web link, not stored in the board: {link}"))]));
    };
    let max = args.get("max_size").and_then(Value::as_u64).map_or(DEFAULT_MAX_SIZE, |m| m.clamp(256, 4096) as u32);
    let bytes = image_bytes(&board, file)?;
    if mime_of(file) == "image/svg+xml" {
        return Ok(tool_ok(vec![text(format!("{id} is an SVG. Its markup:\n\n{}", String::from_utf8_lossy(&bytes)))]));
    }
    let (data, mime, w, h) = prepare(bytes, file, max)?;
    let mut info = describe(item);
    if w > 0 { info["sentAs"] = json!(format!("{w} × {h} {mime}")); }
    info["board"] = json!(board.name);
    Ok(tool_ok(vec![
        json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&data), "mimeType": mime }),
        text(pretty(&info)),
    ]))
}

fn snippet(text: &str, at: usize, len: usize) -> String {
    let start = text[..at].char_indices().rev().nth(80).map_or(0, |(i, _)| i);
    let end = text[at + len..].char_indices().nth(120).map_or(text.len(), |(i, _)| at + len + i);
    format!("{}{}{}", if start > 0 { "…" } else { "" }, &text[start..end], if end < text.len() { "…" } else { "" })
}

fn search(shared: &Shared, args: &Value) -> Result<Value, String> {
    let query = arg(args, "query").ok_or("Say what to look for: pass `query`.")?;
    let needle = query.to_lowercase();
    let boards = match arg(args, "board") {
        Some(key) => vec![find_board(shared, key)?],
        None => all_boards(shared),
    };
    let mut hits = Vec::new();
    for b in &boards {
        for item in &b.items {
            let id = item["id"].as_str().unwrap_or_default();
            if is_note(item) {
                let t = item.get("text").and_then(Value::as_str).unwrap_or_default();
                // Lowercasing can change byte lengths, so match on the lowercased text and map back only when safe.
                let lower = t.to_lowercase();
                if let Some(at) = lower.find(&needle) {
                    let s = if lower.len() == t.len() && t.is_char_boundary(at) && t.is_char_boundary(at + needle.len()) { snippet(t, at, needle.len()) } else { t.chars().take(200).collect() };
                    hits.push(json!({ "board": b.name, "boardId": b.id, "id": id, "type": "note", "match": s }));
                }
            } else {
                let link = item.get("source").and_then(Value::as_str).or_else(|| item.get("src").and_then(Value::as_str));
                if let Some(link) = link.filter(|l| l.to_lowercase().contains(&needle)) {
                    hits.push(json!({ "board": b.name, "boardId": b.id, "id": id, "type": "image", "source": link }));
                }
            }
        }
    }
    if hits.is_empty() {
        return Ok(tool_ok(vec![text(format!("Nothing matches “{query}”."))]));
    }
    Ok(tool_ok(vec![text(pretty(&json!({ "query": query, "matches": hits })))]))
}

/* ───────── JSON-RPC ───────── */

fn initialize(params: Option<&Value>) -> Value {
    let asked = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str).unwrap_or(PROTOCOLS[0]);
    let version = PROTOCOLS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOLS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "trove", "title": "Trove", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Trove holds visual reference boards: images, links and text notes collected for a project. \
            Call list_boards first, then get_board to read a board's notes and image details, and get_image to look at an image. \
            Everything is read-only."
    })
}

/// Answers one JSON-RPC message. Notifications and stray responses get no reply.
pub fn handle_message(shared: &Shared, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str)?;
    let id = msg.get("id").filter(|id| !id.is_null())?.clone();
    let params = msg.get("params");
    let result = match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call_tool(shared, params)),
        _ => Err(json!({ "code": -32601, "message": format!("Method not found: {method}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

/* ───────── HTTP ───────── */

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub json: bool,
}

impl Reply {
    fn empty(status: u16) -> Self {
        Reply { status, body: Vec::new(), json: false }
    }
    fn json(status: u16, v: &Value) -> Self {
        Reply { status, body: serde_json::to_vec(v).unwrap_or_default(), json: true }
    }
}

fn is_local_host(host: &str, port: u16) -> bool {
    ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| host.eq_ignore_ascii_case(&format!("{h}:{port}")))
}

/// Browsers send Origin; agents usually don't. Only pages served from this
/// computer may talk to us (and they still need the token).
fn is_local_origin(origin: &str) -> bool {
    let rest = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.split('/').next().unwrap_or_default();
    let host = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or_default().to_string() };
    ["127.0.0.1", "localhost", "[::1]"].contains(&host.to_ascii_lowercase().as_str())
}

/// Handles one HTTP request to the server.
pub fn handle_http(shared: &Shared, token: &str, port: u16, method: &str, url: &str, headers: &[(String, String)], body: &[u8]) -> Reply {
    let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    // DNS rebinding: a web page can't change the Host it sends, only where it resolves.
    if header("host").is_some_and(|h| !is_local_host(h, port)) || header("origin").is_some_and(|o| !is_local_origin(o)) {
        return Reply::empty(403);
    }
    let path = url.split('?').next().unwrap_or_default();
    if path.trim_end_matches('/') != format!("/mcp/{token}") {
        return Reply::empty(404);
    }
    if method != "POST" {
        return Reply::empty(405); // no server-sent event stream; JSON replies only
    }
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return Reply::json(400, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {e}") } })),
    };
    match parsed {
        Value::Array(batch) => {
            let replies: Vec<Value> = batch.iter().filter_map(|m| handle_message(shared, m)).collect();
            if replies.is_empty() { Reply::empty(202) } else { Reply::json(200, &Value::Array(replies)) }
        }
        msg => match handle_message(shared, &msg) {
            Some(reply) => Reply::json(200, &reply),
            None => Reply::empty(202),
        },
    }
}

/// A running server; dropping it doesn't stop it, `stop` does.
pub struct Running {
    server: Arc<tiny_http::Server>,
    thread: Option<JoinHandle<()>>,
    pub port: u16,
}

impl Running {
    pub fn stop(mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Starts listening on 127.0.0.1:`port`, or on any free port if that one is taken.
pub fn start(shared: Arc<Shared>, port: u16, token: String) -> Result<Running, String> {
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .or_else(|_| tiny_http::Server::http(("127.0.0.1", 0)))
        .map_err(|e| format!("Couldn't start the MCP server: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("Couldn't start the MCP server.")?;
    let server = Arc::new(server);
    let listener = server.clone();
    let thread = std::thread::spawn(move || {
        for request in listener.incoming_requests() {
            let (shared, token) = (shared.clone(), token.clone());
            std::thread::spawn(move || serve(&shared, &token, port, request));
        }
    });
    Ok(Running { server, thread: Some(thread), port })
}

fn serve(shared: &Shared, token: &str, port: u16, mut request: tiny_http::Request) {
    let headers: Vec<(String, String)> = request.headers().iter().map(|h| (h.field.as_str().to_string(), h.value.as_str().to_string())).collect();
    let mut body = Vec::new();
    if request.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        let _ = request.respond(tiny_http::Response::empty(413));
        return;
    }
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let reply = handle_http(shared, token, port, &method, &url, &headers, &body);
    let mut response = tiny_http::Response::from_data(reply.body).with_status_code(reply.status);
    if reply.json {
        response.add_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
    }
    if reply.status == 405 {
        response.add_header(tiny_http::Header::from_bytes("Allow", "POST").unwrap());
    }
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])));
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).unwrap();
        out
    }

    /// A saved board "Portfolio Site" in references.trv, and an open, unsaved board.
    fn fixture(tag: &str) -> (Arc<Shared>, PathBuf, String) {
        let root = temp_dir(tag);
        let src = root.join("src");
        std::fs::create_dir_all(project::images_dir(&src)).unwrap();
        std::fs::write(project::images_dir(&src).join("big.png"), png(2400, 1600)).unwrap();
        let file = root.join("references.trv");
        let manifest = json!({ "format": "trove", "version": 2, "name": "Portfolio Site", "items": [
            { "id": "n1", "kind": "text", "text": "Hero type should feel quiet and very large.", "createdAt": 1795990000000.0, "pos": 2 },
            { "id": "i1", "file": "big.png", "w": 2400, "h": 1600, "tone": [201, 132, 74], "source": "https://example.com/hero", "pos": 1 },
            { "id": "w1", "src": "https://example.com/linked.jpg", "w": 800, "h": 600, "pos": 0 }
        ]});
        project::write(&file, &manifest, &src).unwrap();

        let session = root.join("session");
        std::fs::create_dir_all(project::images_dir(&session)).unwrap();
        std::fs::write(project::images_dir(&session).join("small.png"), png(64, 48)).unwrap();
        let shared = Arc::new(Shared {
            snapshot: RwLock::new(Snapshot {
                open: Some(OpenBoard {
                    name: "Moodboard".into(),
                    path: None,
                    unsaved: true,
                    items: vec![
                        json!({ "id": "n2", "kind": "text", "text": "Warm greys. Never pure black.", "pos": 5 }),
                        json!({ "id": "i2", "file": "small.png", "w": 64, "h": 48, "pos": 4 }),
                    ],
                }),
                library: vec![file.display().to_string()],
            }),
            session_dir: Box::new(move || Some(session.clone())),
        });
        (shared, root, file.display().to_string())
    }

    fn call(shared: &Shared, name: &str, args: Value) -> Value {
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } });
        handle_message(shared, &msg).unwrap()["result"].clone()
    }

    fn first_text(result: &Value) -> String {
        result["content"].as_array().unwrap().iter().find(|c| c["type"] == "text").unwrap()["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn handshake_and_tool_list() {
        let (shared, root, _) = fixture("handshake");
        let init = handle_message(&shared, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "trove");
        let unknown = handle_message(&shared, &json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).unwrap();
        assert_eq!(unknown["result"]["protocolVersion"], PROTOCOLS[0]);
        assert!(handle_message(&shared, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let list = handle_message(&shared, &json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" })).unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_boards", "get_board", "get_image", "search"]);
        let missing = handle_message(&shared, &json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" })).unwrap();
        assert_eq!(missing["error"]["code"], -32601);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn boards_notes_and_images() {
        let (shared, root, file) = fixture("tools");
        let boards: Value = serde_json::from_str(&first_text(&call(&shared, "list_boards", json!({})))).unwrap();
        let boards = boards["boards"].as_array().unwrap();
        assert_eq!(boards.len(), 2);
        assert_eq!(boards[0]["id"], "open");
        assert_eq!(boards[0]["unsavedChanges"], true);
        assert_eq!(boards[1]["name"], "Portfolio Site");
        assert_eq!(boards[1]["file"], file.as_str());
        assert_eq!((boards[1]["notes"].as_u64(), boards[1]["images"].as_u64()), (Some(1), Some(2)));

        // by name, case-insensitively, and by file name
        let board: Value = serde_json::from_str(&first_text(&call(&shared, "get_board", json!({ "board": "portfolio site" })))).unwrap();
        let items = board["items"].as_array().unwrap();
        assert_eq!(items[0]["text"], "Hero type should feel quiet and very large.");
        assert_eq!(items[0]["added"], "2026-11-29T22:06:40Z");
        assert_eq!(items[1]["dominantColor"], "#c9844a");
        assert_eq!(items[1]["source"], "https://example.com/hero");
        assert_eq!(items[2]["webLinkOnly"], true);
        assert!(call(&shared, "get_board", json!({ "board": "references" }))["isError"] == false);
        assert!(call(&shared, "get_board", json!({ "board": "nope" }))["isError"] == true);

        // a big image from a saved file is scaled down to fit
        let id = boards[1]["id"].as_str().unwrap();
        let img = call(&shared, "get_image", json!({ "board": id, "id": "i1" }));
        let content = img["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        let data = base64::engine::general_purpose::STANDARD.decode(content[0]["data"].as_str().unwrap()).unwrap();
        let sent = image::load_from_memory(&data).unwrap();
        assert_eq!((sent.width(), sent.height()), (1568, 1045));
        assert_eq!(content[0]["mimeType"], "image/jpeg");
        // a small one from the open board passes through untouched
        let small = call(&shared, "get_image", json!({ "board": "open", "id": "i2" }));
        assert_eq!(small["content"][0]["mimeType"], "image/png");
        // notes and web links are explained, not failed
        assert!(first_text(&call(&shared, "get_image", json!({ "board": "open", "id": "n2" }))).contains("text note"));
        assert!(first_text(&call(&shared, "get_image", json!({ "board": id, "id": "w1" }))).contains("https://example.com/linked.jpg"));

        // search across boards, and within one
        let hits: Value = serde_json::from_str(&first_text(&call(&shared, "search", json!({ "query": "BLACK" })))).unwrap();
        assert_eq!(hits["matches"][0]["board"], "Moodboard");
        assert!(first_text(&call(&shared, "search", json!({ "query": "example.com", "board": "Portfolio Site" }))).contains("linked.jpg"));
        assert!(first_text(&call(&shared, "search", json!({ "query": "zebra" }))).contains("Nothing matches"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn http_guards() {
        let (shared, root, _) = fixture("http");
        let host = vec![("Host".to_string(), "127.0.0.1:9000".to_string())];
        let ping = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let ok = handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &host, ping);
        assert_eq!((ok.status, ok.json), (200, true));
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/wrong", &host, ping).status, 404);
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &[("Host".into(), "evil.example:9000".into())], ping).status, 403);
        let from_web = vec![host[0].clone(), ("Origin".to_string(), "https://evil.example".to_string())];
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &from_web, ping).status, 403);
        let from_local = vec![host[0].clone(), ("Origin".to_string(), "http://localhost:5173".to_string())];
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &from_local, ping).status, 200);
        assert_eq!(handle_http(&shared, "secret", 9000, "GET", "/mcp/secret", &host, b"").status, 405);
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &host, br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).status, 202);
        assert_eq!(handle_http(&shared, "secret", 9000, "POST", "/mcp/secret", &host, b"{nope").status, 400);
        let batch = handle_http(&shared, "secret", 9000, "POST", "/mcp/secret/", &host, br#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"x"}]"#);
        assert_eq!(serde_json::from_slice::<Value>(&batch.body).unwrap().as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serves_over_tcp() {
        let (shared, root, _) = fixture("tcp");
        let running = start(shared, 0, "tok123".into()).unwrap();
        let port = running.port;
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST /mcp/tok123 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut reply = String::new();
        s.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("application/json") && reply.contains(r#""name":"trove""#), "{reply}");
        running.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Serves the fixture on a fixed port for a while, for testing with real MCP clients:
    /// cargo test serve_fixture -- --ignored --nocapture
    #[test]
    #[ignore]
    fn serve_fixture() {
        let (shared, _root, _) = fixture("serve");
        let running = start(shared, 8799, "fixturetoken0000".into()).unwrap();
        println!("listening on http://127.0.0.1:{}/mcp/fixturetoken0000", running.port);
        std::thread::sleep(std::time::Duration::from_secs(90));
        running.stop();
    }
}
