# Trove

A desktop app for collecting visual references. Paste or drop images into boards, browse them in a masonry grid, and keep the window on top of whatever you're working in.

Trove borrows from two apps. From Pinterest it takes collecting and browsing: boards, a masonry grid, the image as the card. From PureRef it takes working with references: almost no chrome, keyboard control, always on top, local files.

## Status

Early. The Library view works: boards saved as `.trv` files, the masonry grid, images and text notes, organizing. The Canvas view isn't built yet.

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

Double-clicking `.trv` files only works once Trove is installed, because the installer registers the file type. During `tauri dev`, use Open board (`Ctrl O`) instead.

Recommended editor setup: [VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.

## Concept

- **One library, two views.**
  - **Library** (Pinterest-like): masonry grid, boards and search, for collecting and browsing. Built.
  - **Canvas** (PureRef-like): a freeform surface where you place, scale and compare references while you work. Planned.
  - A "send selection to canvas" action connects the two.
- **Local first.** Images live on your machine. No account, no network needed.
- **What both apps lack:** tags and search across every board, offline-first storage, and full keyboard control. Trove aims to fill those gaps.

## What the app does

**Boards are files**
- Every board is its own project: one `.trv` file holding the board's images and notes. One board is open at a time.
- New board (`Ctrl N`) starts an unsaved board with its title ready to type. Save (`Ctrl S`) asks where to put it the first time, suggesting the board's name.
- A board's name is stored inside its file, so the file can be called anything: `references.trv` can hold a board called Portfolio Site. Renaming a board (click its title) is an edit you save like any other, and never touches the file name. An unnamed board takes the file name you choose when you first save it. The board menu shows which file a board lives in.
- The board menu (the `···` button in the header) has Rename, Save, Save as and Delete board. Delete moves the `.trv` file to the Recycle Bin (Trash on macOS and Linux) after a second click, so it can be restored. An unsaved board is discarded instead.
- Double-click a `.trv` file to open it in Trove. If Trove is already running, the open window switches to that board.
- Before switching boards or closing the window throws away unsaved work, Trove asks whether to save. Unsaved changes show as a dot on the board's row and next to its title, and as a `*` in the window title.
- The last board reopens when Trove starts.

**Sidebar: your board library**
- Every saved board Trove knows about, plus the open one, grouped by when they last changed (Today, Yesterday, This week, This month, Earlier). Each row shows a cover image and how many cards the board holds, read from the file without opening it.
- Click a row to open that board. Open board… (`Ctrl O`) adds a `.trv` from anywhere to the library.
- A row's `···` menu can open the board, remove it from the sidebar (the file is left alone), or delete it.
- Search filters the boards by name.
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

**Notes**
- The dock at the bottom of the board is a composer. Type into it, or just start typing anywhere on the board, and press Enter: the note lands on the board as a text card. Shift+Enter adds a line, Esc closes it.
- A note is a card like an image: a neutral grey tile with the words set inside in Geist. A few words are set large, and a paragraph reads as body text. Size, weight and line spacing follow one continuous curve over the note's length, and scale with the column width like the images do.
- Each note card is tall enough for all of its text, so nothing is cut off. A short note keeps a tile shape.
- Click a note to edit it in place. The card lifts while you type and grows to fit. Enter or Esc finishes, Shift+Enter adds a line. Emptying a note removes it, and Undo brings it back.
- While you type, the composer previews the note on the same curve.
- A note whose last line starts with "—" reads as a quote: the opening quotation mark hangs into the margin and the source sits small underneath.
- A link typed into the composer is added as an image if it is one, and as a note if not.
- Hover a note for Copy and Remove in its corner. Space opens it large in focus view, which also has Edit.

**Organizing**
- Drag cards to reorder them.
- Drag a card onto another board in the sidebar to move it into that board's file. Moves can be undone until you switch boards.

**Focus view**
- Click an image, or hover it and press Space, to show it on its own. Arrow keys step through the board.
- The footer shows the image's size, when it was added and its source domain, with Copy and Remove buttons.

**Everything else**
- Confirmations appear as a small toast above the composer, with Undo when it applies.
- A Keep on top button keeps the window above other apps.
- Light and dark themes.
- Runs fully offline. The fonts ship with the app.

## Keyboard

On macOS, Cmd replaces Ctrl.

| Shortcut | Action |
|---|---|
| `Ctrl N` | New board |
| `Ctrl O` | Open a board file |
| `Ctrl S` | Save the board |
| `Ctrl Shift S` | Save the board under a new name |
| `Ctrl V` | Paste an image or link into the current board |
| Any letter | Start a note in the composer (`Enter` adds it, `Shift Enter` adds a line, `Esc` closes) |
| `Ctrl K` | Search boards |
| `Ctrl B` | Show or hide the sidebar |
| `Ctrl Shift A` | Keep the window on top |
| `Ctrl =` / `Ctrl -` | Bigger / smaller thumbnails |
| `Ctrl Z` | Restore the last removed card |
| `Space` | Open the hovered card in focus view (`Space` or `Esc` closes it) |
| `Enter` | Edit the hovered note (`Enter` or `Esc` finishes) |
| `←` / `→` | Previous / next card in focus view |
| `Delete` | Remove the hovered or focused card |
| `Ctrl C` | Copy the hovered image or note |
| `Esc` | Close a menu or focus view, or cancel a drag |

## The .trv format

A `.trv` file is one board, stored as a zip archive:

```text
project.json        the board's cards and their metadata
images/<id>.<ext>   every image on the board, in its original format
```

`project.json` looks like this:

```json
{
  "format": "trove",
  "version": 2,
  "name": "Portfolio Site",
  "createdAt": 1795990000000,
  "updatedAt": 1795996000000,
  "savedAt": 1795996800000,
  "items": [
    { "id": "p0q8r7st", "file": "p0q8r7st.png", "w": 1600, "h": 1200,
      "color": "rgb(182, 140, 101)", "tone": [201, 132, 74], "createdAt": 1795995000000, "pos": 1795995000000 },
    { "id": "n4m2k8qa", "kind": "text", "text": "Warm greys. Never pure black.",
      "createdAt": 1795995600000, "pos": 1795995600000 }
  ]
}
```

- `name` is the board's name, independent of the file name. Files without one are named after the file.
- `file` names an image inside `images/`. Images kept as web links have `src` (their address) instead.
- Notes have `"kind": "text"` and their words in `text`.
- `color` is an image's average colour (the placeholder while it loads). `tone` is its dominant colour, used for the board palette.
- `pos` sets the order on the board, highest first.
- Trove refuses files whose `format` isn't `"trove"`, and files with a newer `version` than it understands. Version 1 files, which held several boards, open as one board with all their cards.

While a board is open, its images sit unpacked in a working folder under the app's cache directory (`%LOCALAPPDATA%\com.absideon.trove\sessions\` on Windows). The webview shows them from there. Saving packs them back into the `.trv`. Trove writes to a temporary file first and then swaps it in, so a failed save can't damage the existing file. Moving a card to another board edits that board's file the same way, without opening it. The sidebar's cover images are unpacked into `thumbs\` in the same cache directory.

## Design direction

- **Logo:** the masonry mark (two columns of rounded tiles, staggered like a board), light on a rounded near-black square with one tile in the accent orange. The same mark is the app icon (`src-tauri/icons`, generated with `bun run tauri icon`) and the logo in the sidebar.
- **Type:** Mona Sans for the interface, a variable font with adjustable width and weight. Notes are set in Geist. Both are bundled in `src/fonts` under the SIL Open Font License. Titles are large and tight: 52px, weight 580, letter spacing -0.052em. Body text is 13.5px.
- **Colour:** a warm off-white light theme, a near-black dark theme, and one orange accent.

  | Token | Light | Dark |
  |---|---|---|
  | Window | `#ebeae5` | `#0a0a09` |
  | Panel | `#fbfaf8` | `#151514` |
  | Text | `#141413` | `#edece7` |
  | Muted text | `#67655f` | `#9b998f` |
  | Accent | `#ff4d1a` | `#ff5a2a` |

- **Layout:** a 256px sidebar sits directly on the window surface. The board sits in a single rounded panel (16px radius, 8px inset from the window edge). Cards have a 14px radius, a 14px gap and 36px of side padding.
- **Quiet chrome:** cards slide under the header into a gradual blur (ten stacked backdrop blurs growing from a fifth of a pixel to 24px towards the top edge, with a tint of the panel colour). It starts faint enough that there is no visible line where it begins. A thin custom scroll indicator replaces the native scrollbar.
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
