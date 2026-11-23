# Trove

A desktop app for collecting visual references. Paste or drop images into boards, browse them in a masonry grid, and keep the window on top of whatever you're working in.

Trove borrows from two apps. From Pinterest it takes collecting and browsing: boards, a masonry grid, the image as the card. From PureRef it takes working with references: almost no chrome, keyboard control, always on top, local files.

## Status

Early. The Library view works: boards, the masonry grid, adding and organizing images, and saving everything as `.trv` project files. The Canvas view isn't built yet.

The UI started as a single-file HTML prototype (`design/trove.html`). It's kept locally for reference and isn't tracked in git.

## Development

Needs [Bun](https://bun.sh) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust, plus WebView2 on Windows).

```sh
bun install                   # install the Tauri CLI
bun run tauri dev             # run the desktop app in development
bun run tauri build           # build installers (src-tauri/target/release/bundle/)
cd src-tauri && cargo test    # project file format tests
```

The frontend lives in `src/` (plain HTML, CSS and JavaScript, served as-is). The Rust side lives in `src-tauri/`. `src-tauri/src/project.rs` owns the `.trv` format, and `src-tauri/src/lib.rs` holds the commands the frontend calls.

Double-clicking `.trv` files only works once Trove is installed, because the installer registers the file type. During `tauri dev`, use Open (`Ctrl O`) instead.

Recommended editor setup: [VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.

## Concept

- **One library, two views.**
  - **Library** (Pinterest-like): masonry grid, boards and search, for collecting and browsing. Built.
  - **Canvas** (PureRef-like): a freeform surface where you place, scale and compare references while you work. Planned.
  - A "send selection to canvas" action connects the two.
- **Local first.** Images live on your machine. No account, no network needed.
- **What both apps lack:** tags and search across every board, offline-first storage, and full keyboard control. Trove aims to fill those gaps.

## What the app does

**Projects**
- A project is one `.trv` file holding a set of boards and all their images. One project is open at a time.
- The sidebar footer shows the project's name, how many images it holds, and whether it has unsaved changes. Click it for the project menu: New project, Open, Save, Save as, recent projects, and Delete project.
- Delete project moves the `.trv` file to the Recycle Bin (Trash on macOS and Linux) after you confirm, so it can be restored. An unsaved project is discarded instead.
- Double-click a `.trv` file to open it in Trove. If Trove is already running, the open window switches to that project.
- Before New, Open or closing the window throws away unsaved work, Trove asks whether to save. The window title shows a `*` while there are unsaved changes.
- The last project reopens when Trove starts.

**Sidebar**
- Boards grouped by when they last changed (Today, Yesterday, Previous 7 days, Previous 30 days, Earlier), each with a thumbnail and an image count.
- Search to filter boards, and a New board button.
- Collapses out of the way. In windows narrower than 860px it slides over the board instead.

**Board header**
- A large title you can edit in place. It shrinks into a compact title as you scroll.
- Image count, last-updated time, and a palette of up to 6 colours picked from the board's images. Click a swatch to copy its hex value.

**Grid**
- Shortest-column masonry. Each card reserves its height from the image's aspect ratio, so nothing jumps when images load.
- Before an image loads, its card is filled with the image's average colour.
- A slider sets the column width, from 150 to 440px (default 210).
- On hover a card shows its pixel dimensions, plus Copy and Remove buttons.

**Adding images**
- Paste an image, a screenshot or an image link. Drop in files or links. Or use the file picker.
- Images are copied into the project, so a `.trv` file is self-contained. Pasting a link downloads the image. If the site won't allow the download, the image is kept as a web link and needs a connection to show.
- An empty board says "Paste anything." and shows Ctrl and V keycaps that press down as you type them.

**Organizing**
- Drag cards to reorder them.
- Drag a card onto a board in the sidebar to move it there. Moves can be undone.
- Deleting a board takes two clicks.

**Focus view**
- Click an image, or hover it and press Space, to show it on its own. Arrow keys step through the board.
- The footer shows the image's size, when it was added and its source domain, with Copy and Remove buttons.

**Everything else**
- A dock at the bottom of the board works as the Add button and doubles as a toast, with Undo when it applies.
- A Keep on top button keeps the window above other apps.
- Light and dark themes.
- Runs fully offline. The font ships with the app.

## Keyboard

On macOS, Cmd replaces Ctrl.

| Shortcut | Action |
|---|---|
| `Ctrl S` | Save the project |
| `Ctrl Shift S` | Save the project under a new name |
| `Ctrl O` | Open a project |
| `Ctrl Shift N` | New project |
| `Ctrl V` | Paste an image or link into the current board |
| `Ctrl N` | New board |
| `Ctrl K` | Search boards |
| `Ctrl B` | Show or hide the sidebar |
| `Ctrl Shift A` | Keep the window on top |
| `Ctrl =` / `Ctrl -` | Bigger / smaller thumbnails |
| `Ctrl Z` | Restore the last removed image |
| `Space` | Open the hovered image in focus view (`Space` or `Esc` closes it) |
| `←` / `→` | Previous / next image in focus view |
| `Delete` | Remove the hovered or focused image |
| `Ctrl C` | Copy the hovered image |
| `Esc` | Close a menu or focus view, or cancel a drag |

## The .trv format

A `.trv` file is a zip archive:

```text
project.json        boards, images and their metadata
images/<id>.<ext>   every image in the project, in its original format
```

`project.json` looks like this:

```json
{
  "format": "trove",
  "version": 1,
  "savedAt": 1795996800000,
  "activeBoard": "k3j9x2ab",
  "boards": [{ "id": "k3j9x2ab", "name": "Slow light", "createdAt": 1795990000000, "updatedAt": 1795996000000 }],
  "items": [
    { "id": "p0q8r7st", "boardId": "k3j9x2ab", "file": "p0q8r7st.png", "w": 1600, "h": 1200,
      "color": "rgb(182, 140, 101)", "tone": [201, 132, 74], "createdAt": 1795995000000, "pos": 1795995000000 }
  ]
}
```

- `file` names an image inside `images/`. Images kept as web links have `src` (their address) instead.
- `color` is the image's average colour (the placeholder while it loads). `tone` is its dominant colour, used for the board palette.
- `pos` sets the order within a board, highest first.
- Trove refuses files whose `format` isn't `"trove"`, and files with a newer `version` than it understands.

While a project is open, its images sit unpacked in a working folder under the app's cache directory (`%LOCALAPPDATA%\com.absideon.trove\sessions\` on Windows). The webview shows them from there. Saving packs them back into the `.trv`. Trove writes to a temporary file first and then swaps it in, so a failed save can't damage the existing file.

## Design direction

- **Type:** Mona Sans, a variable font with adjustable width and weight, bundled in `src/fonts` under the SIL Open Font License. Titles are large and tight: 52px, weight 580, letter spacing -0.052em. Body text is 13.5px.
- **Colour:** a warm off-white light theme, a near-black dark theme, and one orange accent.

  | Token | Light | Dark |
  |---|---|---|
  | Window | `#ebeae5` | `#0a0a09` |
  | Panel | `#fbfaf8` | `#151514` |
  | Text | `#141413` | `#edece7` |
  | Muted text | `#67655f` | `#9b998f` |
  | Accent | `#ff4d1a` | `#ff5a2a` |

- **Layout:** a 256px sidebar sits directly on the window surface. The board sits in a single rounded panel (16px radius, 8px inset from the window edge). Cards have a 14px radius, a 14px gap and 36px of side padding.
- **Quiet chrome:** images fade out under a soft progressive blur at the top of the panel, and a thin custom scroll indicator replaces the native scrollbar.
- **Motion:** eased with `cubic-bezier(.16, 1, .3, 1)`. The sidebar animates over 0.5s, and the cards resize in the same motion. Animations switch off when the system asks for reduced motion.

## Ideas taken from each app

**From Pinterest**
- Shortest-column masonry with known aspect ratios.
- Dominant-colour placeholders. Virtualization (rendering only the cards in view) is still to come.
- The image is the card, with one main hover action.
- Collage covers for boards (one large image, two small).
- "More like this", driven by tags or colour.

**From PureRef**
- No toolbars. Commands live in a right-click menu, shortcuts and a command palette.
- Always on top, click-through and window opacity, for keeping references over another app.
- Import by paste, drag or URL.
- Edits can be undone, such as crop and transforms.
- Local files with the images embedded, so a project is portable. Done: `.trv` files.

## Desktop notes (Tauri 2)

`withGlobalTauri` is on and there's no bundler, so the APIs live under `window.__TAURI__` (for example `window.__TAURI__.window.getCurrentWindow()`). Each window API also needs a matching permission in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json), for example `core:window:allow-set-always-on-top`.

How the app uses Tauri today:

| Feature | Approach |
|---|---|
| Always on top | `getCurrentWindow().setAlwaysOnTop()` |
| File drop | HTML5 drag and drop (`"dragDropEnabled": false` on the window), so links dragged from a browser work too |
| Paste image | The DOM `paste` event |
| Showing project images | `convertFileSrc()`, with the asset protocol scoped to `$APPCACHE/sessions/**` |
| Writing images | `invoke('image_put', bytes, { headers: { 'x-file': name } })`, which sends the raw bytes without JSON encoding |
| Open / save dialogs | `tauri-plugin-dialog` |
| Double-click to open | `bundle.fileAssociations` for the installer, plus `tauri-plugin-single-instance` to hand files to the running window |

Planned window features:

| Feature | Approach |
|---|---|
| Frameless window | `"decorations": false` in `tauri.conf.json`, plus a custom title bar using `data-tauri-drag-region` or `startDragging()` |
| Click-through | `setIgnoreCursorEvents(true)`. The window can't receive clicks while this is on, so turning it off needs a global shortcut (`tauri-plugin-global-shortcut`) |
| See-through window | `"transparent": true` on the window. macOS also needs `macOSPrivateApi` |
| Window opacity | No built-in call is known. A transparent window with CSS `opacity` may do the same job (untested) |
| One overlay window per image | A transparent, frameless, always-on-top `WebviewWindow` per image |

## References

- [PureRef handbook](https://www.pureref.com/handbook/)
- [Gestalt Masonry component](https://gestalt.pinterest.systems/web/masonry) (Pinterest's design system)
- [Frontend system design: Pinterest](https://dev.to/zeeshanali0704/frontend-system-design-pinterest-3om2) (masonry layout)
- [A Pinterest progressive web app performance case study](https://readmedium.com/a-pinterest-progressive-web-app-performance-case-study-3bd6ed2e6154) (Addy Osmani)
