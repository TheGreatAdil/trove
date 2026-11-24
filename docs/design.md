# Design notes

How Trove looks and why, what it borrows from other apps, and how it uses Tauri. For what the app does and how to build it, see the [README](../README.md).

## Concept

Trove borrows from two apps. From Pinterest it takes collecting and browsing: boards, a masonry grid, the image as the card. From PureRef it takes working with references: almost no chrome, keyboard control, always on top, local files.

- **One library, two views.**
  - **Library** (Pinterest-like): masonry grid, boards and search, for collecting and browsing. Built.
  - **Canvas** (PureRef-like): a freeform surface where you place, scale and compare references while you work. Planned.
  - A "send selection to canvas" action would connect the two.
- **Local first.** Images live on your machine. No account, no network needed.
- **What both apps lack:** tags and search across every board, offline-first storage, and full keyboard control. Trove aims to fill those gaps.

## Visual design

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

- **Layout:** a 256px sidebar sits directly on the window surface. The board sits in a single rounded panel, 8px in from the window edge. Cards have a 14px radius, a 14px gap and 36px of side padding.
- **Panel corners follow the window's.** Where the OS rounds the window's corners, the panel's radius is the window's minus that 8px gap, so the gap stays even round the corner, but never less than 8px. That gives 8px on Windows 11 (8px windows) and on macOS 27 (reportedly 16pt windows, not yet checked on a Mac). Where windows have square corners (Windows 10, most Linux desktops) it stays at 16px. Each OS's window radius is in `windowRadius()` in `src/main.js`; Rust reports the OS and its version (`src-tauri/src/platform.rs`).
- **Notes:** a note is a card like an image: a neutral grey tile with the words set inside in Geist. A few words are set large and a paragraph reads as body text. Size, weight and line spacing follow one continuous curve over the note's length, and scale with the column width like the images do. A note whose last line starts with "—" reads as a quote: the opening quotation mark hangs into the margin and the source sits small underneath.
- **Quiet chrome:** cards slide under the header into a gradual blur (ten stacked backdrop blurs growing from a fifth of a pixel to 24px towards the top edge, with a tint of the panel colour). It starts faint enough that there is no visible line where it begins. A thin custom scroll indicator replaces the native scrollbar.
- **Motion:** eased with `cubic-bezier(.16, 1, .3, 1)`. The sidebar animates over 0.5s, and the cards resize in the same motion. Animations switch off when the system asks for reduced motion.

## Ideas taken from each app

**From Pinterest**
- Shortest-column masonry with known aspect ratios. Done.
- Dominant-colour placeholders. Done. Virtualization (rendering only the cards in view) is still to come.
- The image is the card, with one main hover action. Done.
- Collage covers for boards (one large image, two small).
- "More like this", driven by tags or colour.

**From PureRef**
- No toolbars. Commands live in a right-click menu, shortcuts and a command palette.
- Always on top (done), click-through and window opacity, for keeping references over another app.
- Import by paste, drag or URL. Done.
- Edits can be undone, such as crop and transforms.
- Local files with the images embedded, so a project is portable. Done: `.trv` files.

## Tauri notes

`withGlobalTauri` is on and there's no bundler, so the APIs live under `window.__TAURI__` (for example `window.__TAURI__.window.getCurrentWindow()`). Each window API also needs a matching permission in [src-tauri/capabilities/default.json](../src-tauri/capabilities/default.json), for example `core:window:allow-set-always-on-top`.

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
| OS and version | A small plugin's init script sets `window.__TROVE_OS__` before the page's scripts run |

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
