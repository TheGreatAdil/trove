# Trove

A desktop app for collecting visual references. Paste or drop images into boards, browse them in a masonry grid, and keep the window on top of whatever you're working in.

Trove borrows from two apps. From Pinterest it takes collecting and browsing: boards, a masonry grid, the image as the card. From PureRef it takes working with references: almost no chrome, keyboard control, always on top, local files.

## Status

Early. The app is a barebones Tauri 2 shell (vanilla JavaScript, no bundler) that opens an empty window. No Trove features are built yet. The UI is prototyped in a single HTML file, `design/trove.html`, which is kept locally and is not tracked in git.

## Development

Needs [Bun](https://bun.sh) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust, plus WebView2 on Windows).

```sh
bun install          # install the Tauri CLI
bun run tauri dev    # run the desktop app in development
bun run tauri build  # build an installer
```

The frontend lives in `src/` and is served as-is. The Rust side lives in `src-tauri/`.

Recommended editor setup: [VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.

## Concept

- **One library, two views.**
  - **Library** (Pinterest-like): masonry grid, boards and search, for collecting and browsing. This is what the prototype covers.
  - **Canvas** (PureRef-like): a freeform surface where you place, scale and compare references while you work. Planned.
  - A "send selection to canvas" action connects the two.
- **Local first.** Images live on your machine. No account, no network needed.
- **What both apps lack:** tags and search across every board, offline-first storage, and full keyboard control. Trove aims to fill those gaps.

## What the prototype does

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
- A Keep on top button calls Tauri's `setAlwaysOnTop` when running in the desktop shell.
- Light and dark themes.
- Data is stored in IndexedDB.

## Keyboard

On macOS, Cmd replaces Ctrl.

| Shortcut | Action |
|---|---|
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

## Design direction

- **Type:** Mona Sans, a variable font with adjustable width and weight. Titles are large and tight: 52px, weight 580, letter spacing -0.052em. Body text is 13.5px.
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
- Local files with the images embedded, so a board is portable.

## Desktop notes (Tauri 2)

`withGlobalTauri` is on and there's no bundler, so the APIs live under `window.__TAURI__` (for example `window.__TAURI__.window.getCurrentWindow()`). The prototype's Keep on top button already calls it. Each window API also needs a matching permission in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json), for example `core:window:allow-set-always-on-top`. The planned window features map like this:

| Feature | Approach |
|---|---|
| Frameless window | `"decorations": false` in `tauri.conf.json`, plus a custom title bar using `data-tauri-drag-region` or `startDragging()` |
| Always on top | `getCurrentWindow().setAlwaysOnTop(true)` |
| Click-through | `setIgnoreCursorEvents(true)`. The window can't receive clicks while this is on, so turning it off needs a global shortcut (`tauri-plugin-global-shortcut`) |
| See-through window | `"transparent": true` on the window. macOS also needs `macOSPrivateApi` |
| Window opacity | No built-in call is known. A transparent window with CSS `opacity` may do the same job (untested) |
| File drop | `getCurrentWebview().onDragDropEvent()` returns file paths |
| Paste image | The DOM `paste` event, or `readImage()` from `tauri-plugin-clipboard-manager` |
| Showing local files | `convertFileSrc()` with the asset protocol enabled and scoped in config |
| One overlay window per image | A transparent, frameless, always-on-top `WebviewWindow` per image |

## References

- [PureRef handbook](https://www.pureref.com/handbook/)
- [Gestalt Masonry component](https://gestalt.pinterest.systems/web/masonry) (Pinterest's design system)
- [Frontend system design: Pinterest](https://dev.to/zeeshanali0704/frontend-system-design-pinterest-3om2) (masonry layout)
- [A Pinterest progressive web app performance case study](https://readmedium.com/a-pinterest-progressive-web-app-performance-case-study-3bd6ed2e6154) (Addy Osmani)
