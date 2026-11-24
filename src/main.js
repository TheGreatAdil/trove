(() => {
'use strict';

/* ───────── helpers ───────── */
const $ = (s, el = document) => el.querySelector(s);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const isWin = /Win/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const TRASH = isWin ? 'Recycle Bin' : 'Trash';
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const errMsg = e => (typeof e === 'string' ? e : e && e.message) || 'Something went wrong';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const DAY = 864e5;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cssNum = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

document.querySelectorAll('[data-kbd]').forEach(el => { el.textContent = `${MOD} ${el.dataset.kbd}`; });

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24); if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function groupOf(t) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const s = start.getTime();
  if (t >= s) return 'Today';
  if (t >= s - DAY) return 'Yesterday';
  if (t >= s - 7 * DAY) return 'This week';
  if (t >= s - 30 * DAY) return 'This month';
  return 'Earlier';
}

/* ───────── state ───────── */
const state = {
  items: [],
  colTarget: +(localStorage.getItem('trove.col') || 210),
  query: '', hovered: null,
};

/* The open board. Every board is its own .trv project file (`path` is null
   until it's saved). Its images live unpacked in `dir`, a session folder the
   Rust side manages, until the board is saved back into its file. */
const project = { path: null, name: 'Untitled board', createdAt: 0, updatedAt: 0, dir: '', sep: '/', dirty: false, rev: 0 };

/* The library: every saved board Trove knows about, listed in the sidebar.
   Paths are kept most recently opened first. `libInfo` holds what
   library_info read from each file: count, last update, cover thumbnail. */
let library = [];
const libInfo = new Map();

// Images stored in the project are shown straight from disk via the asset
// protocol. Links that couldn't be downloaded keep their web address in `src`.
const urls = new Map(); // item id -> display URL
function srcOf(it) {
  if (!it.file) return it.src;
  if (!urls.has(it.id)) urls.set(it.id, convertFileSrc([project.dir, 'images', it.file].join(project.sep)));
  return urls.get(it.id);
}
const thumbOf = srcOf;
const sortKey = it => it.pos ?? it.createdAt; // manual order wins once a card has been dragged
const byId = id => state.items.find(i => i.id === id);
const boardItems = () => [...state.items].sort((a, b) => sortKey(b) - sortKey(a));
const activeBoard = () => project;

/* ───────── elements ───────── */
const app = $('#app'), stage = $('#stage'), grid = $('#grid'), scroll = $('#scroll'), listEl = $('#boardList');
const topEl = $('#top'), head = $('#head'), titleRow = $('#titleRow'), metaEl = $('#meta'), toolsEl = $('#tools');
const titleEl = $('#title'), countEl = $('#count'), updatedEl = $('#updated');
const emptyEl = $('#empty'), dock = $('#dock');
const dockText = $('#dockText'), dockKbd = $('#dockKbd'), dockThumb = $('#dockThumb'), dockBtn = $('#dockBtn');
const drop = $('#drop'), menu = $('#menu'), focus = $('#focus'), focusImg = $('#focusImg');
const densityEl = $('#density'), searchEl = $('#search'), filePick = $('#filePick');
const sbar = $('#sbar'), sthumb = $('#sthumb');

/* ───────── sidebar: the board library ───────── */
// One row per saved board, plus the open board with live data (even unsaved).
function sidebarRows() {
  const rows = library.filter(p => !samePath(p, project.path)).map(p => {
    const i = libInfo.get(p) || {};
    return { path: p, name: baseName(p), count: i.count || 0, updatedAt: i.updatedAt || 0,
      thumb: i.thumb ? convertFileSrc(i.thumb) : null, color: i.color || null };
  });
  const cover = boardItems().find(i => i.file || i.src);
  rows.push({ path: project.path, current: true, name: project.name, count: state.items.length,
    updatedAt: project.updatedAt, thumb: cover ? thumbOf(cover) : null, color: cover ? cover.color : null });
  return rows;
}
function renderSidebar() {
  const all = sidebarRows();
  const q = state.query.trim().toLowerCase();
  const rows = all.filter(r => !q || r.name.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
  listEl.textContent = '';
  if (!rows.length) {
    const d = document.createElement('div'); d.className = 'no-results';
    d.textContent = `No boards match “${state.query.trim()}”`;
    listEl.append(d);
  }
  let last = '';
  for (const r of rows) {
    const g = groupOf(r.updatedAt);
    if (g !== last) {
      const l = document.createElement('div'); l.className = 'group-label'; l.textContent = g;
      listEl.append(l); last = g;
    }
    const a = document.createElement('div');
    a.className = 'board-link' + (r.current ? ' active' : '');
    if (r.path) a.dataset.path = r.path;
    if (r.current) a.dataset.current = '1';
    a.tabIndex = 0; a.title = r.path || 'Not saved yet';
    const th = document.createElement('span'); th.className = 'thumb';
    if (r.thumb) th.style.backgroundImage = `url("${r.thumb}")`;
    else if (r.color) th.style.backgroundColor = r.color;
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = r.name;
    const ct = document.createElement('span'); ct.className = 'count';
    if (r.current && project.dirty) { ct.classList.add('unsaved'); ct.title = 'Unsaved changes'; }
    else ct.textContent = r.count || '';
    const mo = document.createElement('button'); mo.className = 'more'; mo.setAttribute('aria-label', 'Board options');
    mo.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.5" cy="8" r="1.15"/></svg>';
    a.append(th, nm, ct, mo);
    listEl.append(a);
  }
  $('#libStat').innerHTML = `<b>${plural(all.length, 'board')}</b><br>Each saved as a .trv file`;
  renderProject();
}

const linkTarget = link => ({ path: link.dataset.path || null, current: !!link.dataset.current, link });
function activateLink(link) { if (!link.dataset.current) exclusive(() => openProject(link.dataset.path)); }
listEl.addEventListener('click', e => {
  const link = e.target.closest('.board-link'); if (!link) return;
  if (e.target.closest('.more')) { e.stopPropagation(); openBoardMenu(linkTarget(link), e.target.closest('.more')); return; }
  activateLink(link);
});
listEl.addEventListener('keydown', e => {
  const link = e.target.closest('.board-link');
  if (link && e.key === 'Enter') activateLink(link);
});

searchEl.addEventListener('input', () => { state.query = searchEl.value; renderSidebar(); });
searchEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchEl.value = ''; state.query = ''; renderSidebar(); searchEl.blur(); }
  if (e.key === 'Enter') { const f = listEl.querySelector('.board-link'); if (f) { activateLink(f); searchEl.blur(); } }
});

/* ───────── palette ───────── */
const paletteEl = $('#palette');
let paletteTimer = null;
const schedulePalette = () => { clearTimeout(paletteTimer); paletteTimer = setTimeout(renderPalette, 120); };
function renderPalette() {
  const tones = boardItems().map(i => i.tone).filter(Boolean);
  paletteEl.textContent = '';
  if (tones.length < 3) return;
  const dist = (a, b) => { const rm = (a[0] + b[0]) / 2; const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db); };
  const sat = c => { const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; };
  const pick = [tones.reduce((a, b) => sat(b) > sat(a) ? b : a)];
  while (pick.length < Math.min(6, tones.length)) {
    let far = null, fd = -1;
    for (const t of tones) { const d = Math.min(...pick.map(p => dist(p, t))); if (d > fd) { fd = d; far = t; } }
    if (fd < 40) break; pick.push(far);
  }
  const lum = c => .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  pick.sort((a, b) => lum(a) - lum(b)).forEach(c => {
    const s = document.createElement('button'); s.className = 'swatch';
    s.style.setProperty('--c', `rgb(${c})`); s.dataset.hex = hex(c).toUpperCase();
    s.setAttribute('aria-label', `Copy ${s.dataset.hex}`);
    paletteEl.append(s);
  });
}
paletteEl.addEventListener('click', e => {
  const s = e.target.closest('.swatch'); if (!s) return;
  navigator.clipboard.writeText(s.dataset.hex).then(() => toast(`Copied ${s.dataset.hex}`)).catch(() => {});
});

/* ───────── header ───────── */
function renderHead() {
  const b = activeBoard(); if (!b) return;
  if (document.activeElement !== titleEl) titleEl.textContent = b.name;
  const n = boardItems().length;
  countEl.textContent = n || '';
  countEl.title = plural(n, 'reference');
  updatedEl.textContent = n ? `Updated ${ago(b.updatedAt)}` : `Created ${ago(b.createdAt)}`;
  $('#dropTo').textContent = `to ${b.name}`;
}
titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  if (e.key === 'Escape') { titleEl.textContent = activeBoard().name; titleEl.blur(); }
});
titleEl.addEventListener('blur', () => {
  const v = titleEl.textContent.replace(/\s+/g, ' ').trim();
  if (v && v !== project.name) renameBoard(v);
  titleEl.textContent = project.name; renderHead();
  titleEl.scrollLeft = 0;
});
// A saved board's name is its file name, so renaming renames the file.
async function renameBoard(name) {
  if (!project.path) { project.name = name; renderHead(); renderSidebar(); return; }
  const from = project.path;
  try {
    const to = await invoke('project_rename', { path: from, name });
    if (!samePath(from, project.path)) return; // switched boards meanwhile
    project.path = to; project.name = baseName(to);
    library = library.map(p => samePath(p, from) ? to : p); saveLibrary();
  } catch (e) { toast(errMsg(e)); }
  renderHead(); renderSidebar();
}
function focusTitle() {
  requestAnimationFrame(() => {
    titleEl.focus();
    const r = document.createRange(); r.selectNodeContents(titleEl);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
}

/* Header collapses as you scroll: the big title shrinks into a compact one while
   images slide underneath a progressive blur. Nothing in the grid moves. */
let geo = null;
// Distance from the top of `ancestor`. offset* values ignore transforms, but an
// element mid-animation (the header slides in when a board opens) becomes the
// offsetParent of its children, so walk the chain instead of trusting one hop.
function offsetWithin(el, ancestor) {
  let y = 0;
  for (let n = el; n && n !== ancestor; n = n.offsetParent) y += n.offsetTop;
  return y;
}
function measureHead() {
  geo = {
    H: offsetWithin(metaEl, head) + metaEl.offsetHeight,
    rowTop: offsetWithin(titleRow, head), rowH: titleRow.offsetHeight,
    toolsC: offsetWithin(toolsEl, head) + toolsEl.offsetHeight / 2,
  };
  stage.style.setProperty('--head-h', Math.round(geo.H + 32) + 'px');
  updateHeader();
}
function updateHeader() {
  if (!geo) return;
  const p = clamp(scroll.scrollTop / 130, 0, 1);
  const e = p * p * (3 - 2 * p);
  const C = 34, sMin = 0.4;
  const s = 1 - (1 - sMin) * e;
  const ty = (C - geo.rowH * sMin / 2 - geo.rowTop) * e;
  const tx = app.classList.contains('collapsed') ? (92 - cssNum('--pad')) * e : 0;
  titleRow.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(4)})`;
  countEl.style.opacity = clamp(1 - e * 1.8, 0, 1);
  metaEl.style.opacity = clamp(1 - e * 2.2, 0, 1);
  metaEl.style.transform = `translateY(${(-14 * e).toFixed(2)}px)`;
  metaEl.classList.toggle('live', e < .3);
  toolsEl.style.transform = `translateY(${((C - geo.toolsC) * e).toFixed(2)}px)`;
  topEl.classList.toggle('scrolled', scroll.scrollTop > 2);
}
new ResizeObserver(() => measureHead()).observe(head);

/* ───────── custom scroll indicator ───────── */
let sbarTimer = null;
function updateSbar(show) {
  const sh = scroll.scrollHeight, ch = scroll.clientHeight;
  if (sh <= ch + 1) { sbar.style.display = 'none'; return; }
  sbar.style.display = '';
  const th = sbar.clientHeight, h = Math.max(40, th * ch / sh);
  sthumb.style.height = h + 'px';
  sthumb.style.transform = `translateY(${((th - h) * scroll.scrollTop / (sh - ch)).toFixed(1)}px)`;
  if (show) { sbar.classList.add('on'); clearTimeout(sbarTimer); sbarTimer = setTimeout(() => sbar.classList.remove('on'), 900); }
}
let scrollRaf = 0;
scroll.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateHeader(); updateSbar(true); });
}, { passive: true });
sthumb.addEventListener('pointerdown', e => {
  e.preventDefault(); e.stopPropagation();
  sthumb.setPointerCapture(e.pointerId); sbar.classList.add('drag');
  const y0 = e.clientY, top0 = scroll.scrollTop;
  const ratio = (scroll.scrollHeight - scroll.clientHeight) / Math.max(1, sbar.clientHeight - sthumb.offsetHeight);
  const move = ev => { scroll.scrollTop = top0 + (ev.clientY - y0) * ratio; };
  const up = () => { sbar.classList.remove('drag'); sthumb.removeEventListener('pointermove', move); sthumb.removeEventListener('pointerup', up); sthumb.removeEventListener('pointercancel', up); };
  sthumb.addEventListener('pointermove', move); sthumb.addEventListener('pointerup', up); sthumb.addEventListener('pointercancel', up);
});

/* ───────── grid ───────── */
const cards = new Map();
const pos = new Map(); // id -> {x, y, w, h} final layout position inside the grid
function makeCard(it) {
  const el = document.createElement('figure');
  el.className = 'card'; el.dataset.id = it.id;
  const inner = document.createElement('div'); inner.className = 'card-in';
  if (it.color) inner.style.setProperty('--ph', it.color);
  const img = new Image();
  img.alt = ''; img.decoding = 'async'; img.draggable = false;
  // Web links: try a CORS load so colours can be sampled, and fall back to a plain load.
  if (!it.file && !it.tone && it.cors !== false) img.crossOrigin = 'anonymous';
  img.onerror = () => { if (img.crossOrigin) { img.removeAttribute('crossorigin'); it.cors = false; img.src = srcOf(it); } };
  img.onload = () => {
    img.classList.add('loaded');
    if (!it.color || !it.tone) { try { Object.assign(it, readColors(img)); inner.style.setProperty('--ph', it.color); schedulePalette(); } catch {} }
  };
  img.src = srcOf(it);
  const ui = document.createElement('div'); ui.className = 'card-ui';
  ui.innerHTML = `<span class="card-meta">${it.w} × ${it.h}</span>
    <div class="card-actions">
      <button data-act="copy" aria-label="Copy image" title="Copy"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.5 2.75H4.25a1.5 1.5 0 0 0-1.5 1.5v6.25"/></svg></button>
      <button data-act="delete" aria-label="Remove image" title="Remove"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1.5 1.5 0 0 0 1.5 1.35h3.3a1.5 1.5 0 0 0 1.5-1.35l.6-8.4"/></svg></button>
    </div>`;
  inner.append(img, ui);
  el.append(inner);
  // entrance classes hold the transform via fill-mode; drop them once done
  el.addEventListener('animationend', ev => { if (ev.animationName === 'enter' || ev.animationName === 'ring') el.classList.remove('is-enter', 'is-new'); });
  return el;
}

function renderGrid({ entrance = false, fresh = new Set(), animate = false, recount = false } = {}) {
  const items = boardItems();
  const ids = new Set(items.map(i => i.id));
  for (const [id, el] of cards) if (!ids.has(id)) { el.remove(); cards.delete(id); pos.delete(id); }
  items.forEach((it, i) => {
    if (cards.has(it.id)) return;
    const el = makeCard(it);
    if (fresh.has(it.id)) el.classList.add('is-new');
    else if (entrance) { el.classList.add('is-enter'); el.style.setProperty('--d', Math.min(i * 24, 480) + 'ms'); }
    cards.set(it.id, el); grid.append(el);
  });
  layout({ animate, recount });
  schedulePalette();
  const isEmpty = items.length === 0;
  emptyEl.classList.toggle('on', isEmpty);
  dock.classList.toggle('hidden', isEmpty);
}

function clearGrid() { for (const el of cards.values()) el.remove(); cards.clear(); pos.clear(); }

// Shortest-column masonry. `width` lets the sidebar toggle lay out for the final size up front.
// The column count is sticky: a moderate width change (sidebar, window drag) widens the cards
// in place instead of re-packing them; the size slider and board switches recount.
let curCols = 0;
function layout({ animate = false, width, order, recount = false } = {}) {
  const items = order ? order.map(byId).filter(Boolean) : boardItems();
  const W = width || grid.clientWidth; if (!W) return;
  const gap = cssNum('--gap') || 12;
  let cols = Math.max(1, Math.round((W + gap) / (state.colTarget + gap)));
  if (!recount && curCols && curCols !== cols) {
    const ratio = (W - gap * (curCols - 1)) / curCols / state.colTarget;
    if (ratio > .72 && ratio < 1.38) cols = curCols;
  }
  curCols = cols;
  const cw = (W - gap * (cols - 1)) / cols;
  const hs = new Array(cols).fill(0);
  grid.classList.toggle('animate', animate);
  const unplaced = [];
  for (const it of items) {
    const el = cards.get(it.id); if (!el) continue;
    const h = Math.round(cw * it.h / it.w);
    let c = 0; for (let k = 1; k < cols; k++) if (hs[k] < hs[c] - 1) c = k;
    const x = Math.round(c * (cw + gap)), y = hs[c];
    pos.set(it.id, { x, y, w: cw, h });
    if (!el.dataset.placed) { el.style.transition = 'none'; unplaced.push(el); el.dataset.placed = '1'; }
    el.style.width = cw + 'px'; el.style.height = h + 'px';
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    hs[c] += h + gap;
  }
  if (unplaced.length) { grid.offsetHeight; unplaced.forEach(el => el.style.transition = ''); }
  grid.style.height = Math.max(0, Math.max(...hs) - gap) + 'px';
  updateSbar(false);
}

new ResizeObserver(() => requestAnimationFrame(() => { if (!app.classList.contains('syncing')) layout(); })).observe(scroll);

/* key caps on the empty state mirror the real keyboard */
$('#keyModSym').textContent = isMac ? '⌘' : '';
$('#keyModLbl').textContent = isMac ? 'command' : 'ctrl';
const keyMod = $('#keyMod'), keyV = $('#keyV');
document.addEventListener('keydown', e => {
  if (!emptyEl.classList.contains('on')) return;
  if (e.key === 'Control' || e.key === 'Meta') keyMod.classList.add('down');
  if (e.key.toLowerCase() === 'v') keyV.classList.add('down');
});
document.addEventListener('keyup', e => {
  if (e.key === 'Control' || e.key === 'Meta') keyMod.classList.remove('down');
  if (e.key.toLowerCase() === 'v' || e.key === 'Control' || e.key === 'Meta') keyV.classList.remove('down');
});
window.addEventListener('blur', () => { keyMod.classList.remove('down'); keyV.classList.remove('down'); });

let suppressClickUntil = 0;
grid.addEventListener('click', e => {
  if (performance.now() < suppressClickUntil) return;
  const card = e.target.closest('.card'); if (!card) return;
  const act = e.target.closest('[data-act]');
  const it = byId(card.dataset.id); if (!it) return;
  if (act) { e.stopPropagation(); if (act.dataset.act === 'delete') removeItem(it); else copyItem(it); return; }
  openFocus(it.id);
});
grid.addEventListener('mouseover', e => { const c = e.target.closest('.card'); state.hovered = c ? c.dataset.id : null; });
grid.addEventListener('mouseleave', () => { state.hovered = null; });

/* ───────── drag to reorder, or drop on a board to move ───────── */
let drag = null;
grid.addEventListener('pointerdown', e => {
  if (e.button !== 0 || drag) return;
  const card = e.target.closest('.card'); if (!card || e.target.closest('[data-act]')) return;
  const it = byId(card.dataset.id); if (!it) return;
  drag = { it, card, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, pid: e.pointerId, active: false };
});
window.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.active && Math.hypot(drag.x - drag.sx, drag.y - drag.sy) > 6) startDrag();
  if (drag && drag.active) retarget();
});
window.addEventListener('pointerup', e => { if (!drag || e.pointerId !== drag.pid) return; if (drag.active) finishDrag(false); drag = null; });
window.addEventListener('pointercancel', e => { if (!drag || e.pointerId !== drag.pid) return; if (drag.active) finishDrag(true); drag = null; });

function startDrag() {
  const d = drag; d.active = true;
  const r = d.card.getBoundingClientRect();
  d.offX = d.sx - r.left; d.offY = d.sy - r.top; d.w = r.width; d.h = r.height;
  d.order = boardItems().map(i => i.id); d.orig = d.order.slice();
  d.rot = 0; d.px = d.x; d.last = 0; d.link = null;
  const g = document.createElement('div'); g.className = 'ghost';
  g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
  g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
  g.innerHTML = '<div class="ghost-tilt"><div class="ghost-in"></div></div>';
  const gin = g.querySelector('.ghost-in');
  gin.style.background = d.it.color || 'var(--card)';
  gin.style.transformOrigin = `${d.offX}px ${d.offY}px`; // lift and shrink around the grab point
  const im = new Image(); im.alt = ''; im.draggable = false; im.src = srcOf(d.it); gin.append(im);
  document.body.append(g);
  d.ghost = g; d.tilt = g.firstChild;
  requestAnimationFrame(() => g.classList.add('up'));
  d.card.classList.add('ghosted');
  document.body.classList.add('dragging');
  getSelection().removeAllRanges();
  dockHint(app.classList.contains('collapsed') ? 'Drag to reorder' : 'Drag to reorder, or drop on a board');
  try { grid.setPointerCapture(d.pid); } catch {}
  d.raf = requestAnimationFrame(dragTick);
}

function dragTick() {
  const d = drag; if (!d || !d.active) return;
  const vx = d.x - d.px; d.px = d.x;
  d.rot += (clamp(vx * .55, -8, 8) - d.rot) * .16;
  d.ghost.style.transform = `translate3d(${(d.x - d.offX).toFixed(1)}px, ${(d.y - d.offY).toFixed(1)}px, 0)`;
  d.tilt.style.transform = `rotate(${d.rot.toFixed(2)}deg)`;
  // edge auto-scroll
  const sr = scroll.getBoundingClientRect();
  let v = 0;
  if (d.x > sr.left && d.x < sr.right) {
    const topEdge = sr.top + 110, botEdge = sr.bottom - 80;
    if (d.y < topEdge) v = -Math.min(24, (topEdge - d.y) * .22);
    else if (d.y > botEdge) v = Math.min(24, (d.y - botEdge) * .22);
  }
  if (v) { const before = scroll.scrollTop; scroll.scrollTop += v; if (scroll.scrollTop !== before) retarget(); }
  d.raf = requestAnimationFrame(dragTick);
}

function retarget() {
  const d = drag;
  const el = document.elementFromPoint(d.x, d.y);
  const link = el && el.closest ? el.closest('.board-link') : null;
  const target = link && !link.dataset.current && link.dataset.path ? link : null;
  if (target !== d.link) {
    if (d.link) d.link.classList.remove('drop-target');
    d.link = target;
    if (target) target.classList.add('drop-target');
    d.ghost.classList.toggle('over-board', !!target);
    if (target) dockHint(`Move to ${baseName(target.dataset.path)}`);
    else dockHint(app.classList.contains('collapsed') ? 'Drag to reorder' : 'Drag to reorder, or drop on a board');
  }
  if (target) return;
  const gr = grid.getBoundingClientRect();
  const gx = d.x - gr.left, gy = d.y - gr.top;
  if (gx < -24 || gx > gr.width + 24) return;
  const now = performance.now(); if (now - d.last < 110) return;
  let hit = null;
  for (const id of d.order) {
    if (id === d.it.id) continue;
    const p = pos.get(id); if (!p) continue;
    if (gx > p.x + p.w * .1 && gx < p.x + p.w * .9 && gy > p.y + p.h * .1 && gy < p.y + p.h * .9) { hit = id; break; }
  }
  if (!hit) return;
  const from = d.order.indexOf(d.it.id), to = d.order.indexOf(hit);
  if (from === to) return;
  d.order.splice(from, 1); d.order.splice(to, 0, d.it.id);
  d.last = now;
  layout({ animate: true, order: d.order });
}

function finishDrag(cancel) {
  const d = drag; d.active = false; cancelAnimationFrame(d.raf);
  document.body.classList.remove('dragging');
  suppressClickUntil = performance.now() + 120;
  if (d.link) d.link.classList.remove('drop-target');
  resetDock();
  const g = d.ghost;
  const settle = (x, y, scale, onDone) => {
    g.classList.add('settle'); g.classList.remove('up', 'over-board');
    if (scale !== 1) g.classList.add('gone');
    g.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    d.tilt.style.transition = 'transform .5s var(--ease-out)'; d.tilt.style.transform = 'rotate(0deg)';
    let done = false;
    const end = () => { if (done) return; done = true; g.remove(); onDone && onDone(); };
    g.addEventListener('transitionend', ev => { if (ev.target === g && ev.propertyName === 'transform') end(); });
    setTimeout(end, 650);
  };
  if (!cancel && d.link) {
    const targetPath = d.link.dataset.path;
    moveItem(d.it, targetPath);
    const link = [...listEl.querySelectorAll('.board-link')].find(l => l.dataset.path === targetPath);
    const th = link ? link.querySelector('.thumb').getBoundingClientRect() : { left: d.x, top: d.y, width: 18 };
    settle(th.left, th.top, th.width / d.w, () => { if (link) { link.classList.remove('received'); void link.offsetWidth; link.classList.add('received'); } });
    return;
  }
  const changed = !cancel && d.order.some((id, i) => id !== d.orig[i]);
  if (changed) commitOrder(d.order);
  layout({ animate: true });
  const p = pos.get(d.it.id), gr = grid.getBoundingClientRect();
  settle(gr.left + p.x, gr.top + p.y, 1, () => d.card.classList.remove('ghosted'));
}

function commitOrder(order) {
  const base = Date.now();
  order.forEach((id, i) => { const it = byId(id); if (it) it.pos = base - i; });
  touch();
  renderSidebar();
}

// Moving a card to another board writes it straight into that board's file.
// It leaves this board as an unsaved change; its image stays in the session
// folder, so undo can put it back.
async function moveItem(it, path) {
  const session = project.dir, name = baseName(path);
  const putBack = () => {
    state.items.push(it); touch();
    renderGrid({ fresh: new Set([it.id]), animate: true }); renderHead(); renderSidebar();
  };
  state.items = state.items.filter(i => i !== it); touch();
  renderGrid({ animate: true }); renderHead(); renderSidebar();
  try {
    await invoke('project_add_items', { path, items: [{ ...manifestItem(it), pos: Date.now() }] });
  } catch (e) { putBack(); return toast(errMsg(e)); }
  refreshLibrary([path]);
  toast(`Moved to ${name}`, {
    thumb: thumbOf(it), action: 'Undo',
    onAction: () => exclusive(async () => {
      if (project.dir !== session) return toast('The move can’t be undone after switching boards');
      await invoke('project_remove_items', { path, ids: [it.id] });
      putBack(); refreshLibrary([path]);
    }),
  });
}

/* ───────── density ───────── */
densityEl.value = state.colTarget;
densityEl.addEventListener('input', () => { setDensity(+densityEl.value, true); });
function setDensity(v, animate) {
  state.colTarget = clamp(v, 150, 440);
  densityEl.value = state.colTarget;
  localStorage.setItem('trove.col', state.colTarget);
  layout({ animate, recount: true });
}

/* ───────── adding ───────── */
// Average colour (placeholder) + dominant colour (palette) from a 24x24 sample.
function readColors(src) {
  const S = 24, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data;
  let r = 0, g = 0, b = 0; const bins = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    r += R; g += G; b += B;
    const k = (R >> 5) << 6 | (G >> 5) << 3 | (B >> 5);
    const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += R; e.g += G; e.b += B; bins.set(k, e);
  }
  const n = d.length / 4;
  let best = null, bestScore = -1;
  for (const e of bins.values()) {
    const R = e.r / e.n, G = e.g / e.n, B = e.b / e.n;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const sat = mx ? (mx - mn) / mx : 0;
    const score = e.n * (0.4 + sat * 1.6);
    if (score > bestScore) { bestScore = score; best = [R, G, B]; }
  }
  return { color: `rgb(${r / n | 0}, ${g / n | 0}, ${b / n | 0})`, tone: best.map(v => v | 0) };
}
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
function extOf(blob) {
  if (EXT[blob.type]) return EXT[blob.type];
  const m = /\.([a-z0-9]{1,5})$/i.exec(blob.name || '');
  return m ? m[1].toLowerCase() : 'png';
}
// Reads size and colours, then stores the image in the project folder.
async function itemFromBlob(blob, source = null) {
  const bmp = await createImageBitmap(blob);
  const id = uid(), file = `${id}.${extOf(blob)}`;
  const it = { id, file, w: bmp.width, h: bmp.height, ...readColors(bmp), createdAt: Date.now(), source };
  bmp.close && bmp.close();
  await invoke('image_put', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-file': file } });
  return it;
}
async function addFiles(files) {
  const out = [];
  let failed = null;
  for (const f of files) { try { out.push(await itemFromBlob(f)); } catch (err) { console.warn('Skipped file', err); failed = err; } }
  if (out.length) commit(out);
  else toast(typeof failed === 'string' ? failed : 'That file isn’t an image Trove can read');
}
async function addUrl(url) {
  try {
    const r = await fetch(url, { mode: 'cors' });
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not image');
    commit([await itemFromBlob(blob, url)]);
  } catch {
    const img = new Image();
    // The site blocks downloads, so keep it as a link. It needs a connection to show.
    img.onload = () => commit([{ id: uid(), src: url, w: img.naturalWidth, h: img.naturalHeight, color: null, cors: false, createdAt: Date.now(), source: url }], { linked: true });
    img.onerror = () => toast('Couldn’t find an image at that link');
    img.src = url;
  }
}
function commit(newItems, { linked = false } = {}) {
  const b = activeBoard(); const now = Date.now();
  newItems.forEach((it, i) => { it.createdAt = now + i; it.pos = now + i; state.items.push(it); });
  b.updatedAt = now; touch();
  if (scroll.scrollTop > 0) scroll.scrollTo({ top: 0, behavior: 'smooth' });
  renderGrid({ fresh: new Set(newItems.map(i => i.id)), animate: true });
  renderHead(); renderSidebar();
  const last = newItems[newItems.length - 1];
  const msg = linked ? `Added to ${b.name} as a web link`
    : newItems.length === 1 ? `Added to ${b.name}` : `Added ${newItems.length} images to ${b.name}`;
  toast(msg, { thumb: thumbOf(last) });
}

document.addEventListener('paste', e => {
  if (modal.classList.contains('open')) return;
  const t = e.target;
  const editing = t instanceof Element && t.closest('input, textarea, [contenteditable="true"]');
  const dt = e.clipboardData; if (!dt) return;
  const files = [...dt.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); if (editing) t.blur(); addFiles(files); return; }
  if (editing) {
    if (t === titleEl) { e.preventDefault(); document.execCommand('insertText', false, dt.getData('text/plain').replace(/\s+/g, ' ')); }
    return;
  }
  let url = '';
  const html = dt.getData('text/html');
  if (html) { const m = html.match(/<img[^>]+src=["']([^"']+)["']/i); if (m) url = m[1]; }
  if (!url) { const txt = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim(); if (/^https?:\/\/\S+$/i.test(txt)) url = txt; }
  if (url) { e.preventDefault(); addUrl(url); }
});

filePick.addEventListener('change', () => { if (filePick.files.length) addFiles([...filePick.files]); filePick.value = ''; });

/* files dropped in from outside */
let dragDepth = 0;
const dragOk = e => e.dataTransfer && [...e.dataTransfer.types].some(t => t === 'Files' || t === 'text/uri-list');
window.addEventListener('dragenter', e => { if (!dragOk(e)) return; dragDepth++; drop.classList.add('on'); });
window.addEventListener('dragleave', e => { if (!dragOk(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('on'); });
window.addEventListener('dragover', e => { if (dragOk(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!dragOk(e)) return;
  e.preventDefault(); dragDepth = 0; drop.classList.remove('on');
  if ([...e.dataTransfer.files].some(f => /\.trv$/i.test(f.name))) {
    return toast(`Open boards with ${MOD} O, or double-click the .trv file`);
  }
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (files.length) return addFiles(files);
  const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find(l => /^https?:/.test(l));
  if (url) addUrl(url.trim());
});

/* ───────── removing / copying ───────── */
const undo = [];
function removeItem(it) {
  state.items = state.items.filter(i => i !== it);
  touch();
  undo.push(it); // its file stays in the session folder, so undo can bring it back
  if (focus.classList.contains('open')) { const list = boardItems(); if (!list.length) closeFocus(); else { focusIdx = Math.min(focusIdx, list.length - 1); showFocus(); } }
  renderGrid({ animate: true }); renderHead(); renderSidebar();
  toast('Image removed', { action: 'Undo', onAction: restore });
}
function restore() {
  const it = undo.pop(); if (!it) return;
  state.items.push(it); touch();
  renderGrid({ fresh: new Set([it.id]), animate: true }); renderHead();
  renderSidebar(); toast('Restored');
}
// Project images are read through Rust: drawing an asset-protocol image onto a
// canvas could taint it and block the PNG export.
async function blobOf(it) {
  if (it.file) {
    const ext = it.file.split('.').pop();
    return new Blob([await invoke('image_read', { file: it.file })], { type: MIME[ext] || '' });
  }
  return (await fetch(it.src, { mode: 'cors' })).blob();
}
async function toPng(it) {
  const blob = await blobOf(it);
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return new Promise(r => c.toBlob(r, 'image/png'));
}
async function copyItem(it) {
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(it) })]); toast('Copied to clipboard', { thumb: thumbOf(it) }); }
  catch { toast('Couldn’t copy this image'); }
}

/* ───────── dock / toast ───────── */
let toastTimer = null, toastAction = null;
function toast(msg, { thumb, action, onAction } = {}) {
  clearTimeout(toastTimer);
  dock.classList.remove('hint');
  dock.classList.add('toast'); dock.classList.remove('hidden');
  dockText.textContent = msg;
  dockKbd.style.display = 'none';
  dockThumb.classList.toggle('has', !!thumb);
  if (thumb) dockThumb.style.backgroundImage = `url("${thumb}")`;
  dockBtn.querySelector('span').textContent = action || 'Add';
  dockBtn.querySelector('svg').style.display = action ? 'none' : '';
  toastAction = onAction || null;
  toastTimer = setTimeout(resetDock, action ? 5000 : 2600);
}
function dockHint(msg) {
  clearTimeout(toastTimer);
  dock.classList.remove('toast', 'hidden'); dock.classList.add('hint');
  dockThumb.classList.remove('has');
  dockText.textContent = msg;
}
function resetDock() {
  dock.classList.remove('toast', 'hint');
  dockText.textContent = 'Paste an image or link';
  dockKbd.style.display = '';
  dockBtn.querySelector('span').textContent = 'Add';
  dockBtn.querySelector('svg').style.display = '';
  toastAction = null;
  dock.classList.toggle('hidden', boardItems().length === 0);
}

/* ───────── boards ───────── */
// A new board is a new, unsaved project with its title ready to type into.
async function newBoard() {
  if (!await guardUnsaved()) return;
  loadProject(await invoke('project_new'), null);
  if (app.classList.contains('narrow')) app.classList.add('collapsed');
  focusTitle();
}
// Deleting a saved board moves its file to the Recycle Bin / Trash. Deleting
// the open board then opens the most recently used one (or a new board).
async function deleteBoard(path) {
  const isOpen = !path || samePath(path, project.path);
  const name = path ? baseName(path) : project.name;
  if (path) { await invoke('project_delete', { path }); forgetBoard(path); }
  if (isOpen) {
    let opened = null, next = null;
    for (const p of library) {
      try { opened = await invoke('project_open', { path: p }); next = p; break; }
      catch (e) { if (/no longer exists/.test(errMsg(e))) forgetBoard(p); }
    }
    loadProject(opened || await invoke('project_new'), next);
    if (next) rememberBoard(next);
  }
  renderSidebar();
  toast(path ? `Moved ${name} to the ${TRASH}` : 'Board discarded');
}

/* ───────── menu ───────── */
const ICON = {
  open: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.25 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.5h4.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  rename: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/></svg>',
  save: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.75v7.5M5 7.5l3 3 3-3M3 12.75h10"/></svg>',
  saveAs: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4.25 2.25h5l2.5 2.5v9h-7.5z"/><path d="M9.25 2.25v2.5h2.5"/></svg>',
  hide: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1.5 1.5 0 0 0 1.5 1.35h3.3a1.5 1.5 0 0 0 1.5-1.35l.6-8.4"/></svg>',
};
// `target`: { path, current, link } for a sidebar row, or the open board.
let menuFor = null;
function openBoardMenu(target, anchor, alignRight = false) {
  const key = target.current ? 'current' : target.path;
  if (menuFor && menuFor.key === key && menu.classList.contains('open')) return closeMenu();
  closeMenu();
  menuFor = { ...target, key };
  if (target.link) target.link.classList.add('menu-open');
  const item = (m, icon, label, kbd = '') =>
    `<button data-m="${m}">${icon}<span class="grow">${label}</span>${kbd ? `<span class="kbd">${kbd}</span>` : ''}</button>`;
  menu.innerHTML = [
    ...(target.current
      ? [item('rename', ICON.rename, 'Rename'), item('save', ICON.save, 'Save', `${MOD} S`), item('save-as', ICON.saveAs, 'Save as…', `${MOD} Shift S`)]
      : [item('open', ICON.open, 'Open'), item('hide', ICON.hide, 'Remove from sidebar')]),
    '<div class="menu-sep"></div>',
    `<button data-m="delete" class="danger">${ICON.trash}<span>${target.path ? 'Delete board' : 'Discard board'}</span></button>`,
  ].join('');
  const r = anchor.getBoundingClientRect();
  menu.classList.add('wide');
  const w = 248;
  menu.style.left = (alignRight ? r.right - w : Math.min(r.left, innerWidth - w - 8)) + 'px';
  menu.style.top = (r.bottom + 6) + 'px'; menu.style.bottom = '';
  menu.style.transformOrigin = alignRight ? 'top right' : 'top left';
  requestAnimationFrame(() => menu.classList.add('open'));
}
function closeMenu() {
  menu.classList.remove('open'); menuFor = null;
  listEl.querySelectorAll('.menu-open').forEach(el => el.classList.remove('menu-open'));
}
menu.addEventListener('click', e => {
  const btn = e.target.closest('[data-m]'); if (!btn || !menuFor) return;
  const t = menuFor, m = btn.dataset.m;
  if (m === 'delete') {
    // Two clicks, like the mockup: the first arms the button.
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.querySelector('span').textContent = t.path ? `Click again to move to the ${TRASH}` : 'Click again to discard';
      return;
    }
    closeMenu(); exclusive(() => deleteBoard(t.path));
    return;
  }
  closeMenu();
  if (m === 'rename') focusTitle();
  else if (m === 'save') exclusive(() => saveProject());
  else if (m === 'save-as') exclusive(() => saveProject({ as: true }));
  else if (m === 'open') exclusive(() => openProject(t.path));
  else if (m === 'hide') { forgetBoard(t.path); renderSidebar(); toast(`Removed ${baseName(t.path)} from the sidebar. The file is untouched.`); }
});
$('#boardMenuBtn').addEventListener('click', e => {
  e.stopPropagation();
  openBoardMenu({ path: project.path, current: true }, e.currentTarget, true);
});
document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenu(); });

/* ───────── focus view ───────── */
let focusIdx = 0;
function openFocus(id) {
  focusIdx = boardItems().findIndex(i => i.id === id);
  showFocus();
  focus.classList.add('open'); focus.setAttribute('aria-hidden', 'false');
}
function showFocus() {
  const list = boardItems(); const it = list[focusIdx]; if (!it) return;
  focusImg.classList.remove('loaded');
  focusImg.onload = () => focusImg.classList.add('loaded');
  focusImg.src = srcOf(it);
  if (focusImg.complete) focusImg.classList.add('loaded');
  $('#focusBoard').textContent = activeBoard().name;
  $('#focusPos').textContent = `${focusIdx + 1} / ${list.length}`;
  let host = '';
  if (it.source) { try { host = ' · ' + new URL(it.source).hostname.replace(/^www\./, ''); } catch {} }
  $('#focusMeta').textContent = `${it.w} × ${it.h} · Added ${ago(it.createdAt)}${host}`;
}
function closeFocus() { focus.classList.remove('open'); focus.setAttribute('aria-hidden', 'true'); }
function stepFocus(d) { const n = boardItems().length; if (!n) return; focusIdx = (focusIdx + d + n) % n; showFocus(); }
focus.addEventListener('click', e => { if (e.target === focus || e.target.classList.contains('focus-stage')) closeFocus(); });

/* ───────── projects: one board per .trv file ───────── */
const modal = $('#modal');
const FILTERS = [{ name: 'Trove board', extensions: ['trv'] }];
const fileName = p => p.split(/[\\/]/).pop();
const baseName = p => fileName(p).replace(/\.trv$/i, '');
const samePath = (a, b) => !!a && !!b && (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
const hasWork = () => project.dirty && (project.path || state.items.length > 0);
const safeFileName = name => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Untitled board';

// The library list lives in localStorage; the files themselves are the truth.
function loadLibrary() {
  try {
    const raw = localStorage.getItem('trove.library') ?? localStorage.getItem('trove.recent');
    const list = JSON.parse(raw);
    library = Array.isArray(list) ? list.filter(p => typeof p === 'string') : [];
  } catch { library = []; }
}
function saveLibrary() { localStorage.setItem('trove.library', JSON.stringify(library)); }
function rememberBoard(path) { library = [path, ...library.filter(p => !samePath(p, path))]; saveLibrary(); }
function forgetBoard(path) {
  library = library.filter(p => !samePath(p, path));
  for (const k of libInfo.keys()) if (samePath(k, path)) libInfo.delete(k);
  saveLibrary();
}
// Re-reads saved boards for the sidebar. Files that are gone drop out.
async function refreshLibrary(paths = library) {
  if (!paths.length) return renderSidebar();
  let infos = [];
  try { infos = await invoke('library_info', { paths }); } catch (e) { console.warn(e); }
  for (const i of infos) {
    if (i.error && /no longer exists/.test(i.error)) forgetBoard(i.path);
    else libInfo.set(i.path, i);
  }
  renderSidebar();
}

let shownTitle = '';
function renderProject() {
  app.classList.toggle('dirty', project.dirty);
  const title = `${project.dirty ? '*' : ''}${project.name} — Trove`;
  if (title !== shownTitle) { shownTitle = title; document.title = title; appWindow.setTitle(title).catch(() => {}); }
}

// Every edit to the board goes through here.
function touch() { project.rev++; project.dirty = true; project.updatedAt = Date.now(); renderProject(); }

const manifestItem = ({ id, kind, text, file, src, w, h, color, tone, createdAt, pos, source }) =>
  ({ id, kind, text, file, src, w, h, color, tone, createdAt, pos, source });
function manifest() {
  return {
    format: 'trove', version: 2,
    createdAt: project.createdAt, updatedAt: project.updatedAt, savedAt: Date.now(),
    items: state.items.map(manifestItem),
  };
}

// Swaps in a board returned by project_new / project_open.
function loadProject({ dir, manifest: m }, path) {
  const previous = project.path, now = Date.now();
  Object.assign(project, {
    path, dir, sep: dir.includes('\\') ? '\\' : '/', dirty: false, rev: 0,
    name: path ? baseName(path) : 'Untitled board',
    createdAt: +(m && m.createdAt) || now,
    updatedAt: +(m && (m.updatedAt || m.savedAt)) || now,
  });
  urls.clear(); undo.length = 0;
  // Same naming rule the Rust side enforces when unpacking; links must be web addresses.
  // (Version 1 files held several boards: all their items land on this one.)
  const usable = i => typeof i.file === 'string' ? /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,5}$/.test(i.file)
    : typeof i.src === 'string' && /^https?:\/\//i.test(i.src);
  state.items = (m && Array.isArray(m.items) ? m.items : [])
    .filter(i => i && i.id && usable(i) && i.w > 0 && i.h > 0);
  state.query = ''; searchEl.value = '';
  closeFocus(); closeMenu(); clearGrid();
  scroll.scrollTop = 0; updateHeader();
  head.classList.remove('swap'); void head.offsetWidth; head.classList.add('swap');
  renderHead(); renderSidebar(); renderGrid({ entrance: true, recount: true }); resetDock();
  // The board we left needs a fresh summary for its sidebar row.
  if (previous && !samePath(previous, path)) refreshLibrary([previous]);
}

// One board operation at a time (a save while a dialog is open, double shortcuts...).
let busy = false;
async function exclusive(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (e) { console.error(e); toast(errMsg(e)); }
  finally { busy = false; }
}

// Asks before unsaved work is thrown away. Resolves true when it's fine to go on.
async function guardUnsaved() {
  if (!hasWork()) return true;
  const choice = await confirmDialog({
    title: `Save changes to “${project.name}”?`,
    body: 'Your changes will be lost if you don’t save them.',
    buttons: [
      { label: 'Don’t save', value: 'discard', start: true },
      { label: 'Cancel', value: 'cancel', cancel: true },
      { label: 'Save', value: 'save', kind: 'primary', focus: true },
    ],
  });
  if (choice === 'save') return saveProject();
  return choice === 'discard';
}

// Opens a board from a path, or asks for one.
async function openProject(path) {
  if (!path) {
    path = await dialog.open({ title: 'Open board', filters: FILTERS, multiple: false, directory: false });
    if (!path) return;
  }
  if (samePath(path, project.path) && !project.dirty) return;
  if (!await guardUnsaved()) return;
  try {
    loadProject(await invoke('project_open', { path }), path);
    rememberBoard(path);
    if (app.classList.contains('narrow')) app.classList.add('collapsed');
  } catch (e) {
    const msg = errMsg(e);
    if (/no longer exists/.test(msg)) forgetBoard(path);
    toast(msg);
  }
  renderSidebar();
}

// Resolves true once the board is safely on disk.
async function saveProject({ as = false } = {}) {
  if (document.activeElement === titleEl) titleEl.blur(); // keep a rename in progress
  let path = project.path;
  if (as || !path) {
    path = await dialog.save({ title: 'Save board', filters: FILTERS, defaultPath: project.path || `${safeFileName(project.name)}.trv` });
    if (!path) return false;
  }
  const rev = project.rev;
  try {
    const res = await invoke('project_save', { path, manifest: manifest() });
    project.path = res.path; project.name = baseName(res.path);
    project.dirty = project.rev !== rev; // edits made while saving still count
    rememberBoard(res.path);
    renderHead(); renderSidebar();
    toast(res.missing ? `Saved, but ${plural(res.missing, 'image')} couldn’t be found` : `Saved ${project.name}`);
    return true;
  } catch (e) {
    toast(errMsg(e));
    return false;
  }
}

/* In-app dialog. Resolves with the clicked button's value, or the cancel
   button's value on Esc / clicking outside. */
let modalDone = null;
function confirmDialog({ title, body, buttons }) {
  if (modalDone) modalDone();
  closeMenu();
  return new Promise(resolve => {
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    const actions = $('#modalActions'); actions.textContent = '';
    const cancel = buttons.find(b => b.cancel);
    const done = value => {
      modalDone = null;
      modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true');
      resolve(value);
    };
    let focusEl = null;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = ['btn', b.kind, b.start && 'start'].filter(Boolean).join(' ');
      el.textContent = b.label;
      el.addEventListener('click', () => done(b.value));
      actions.append(el);
      if (b.focus) focusEl = el;
    }
    modalDone = () => done(cancel ? cancel.value : null);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    (focusEl || actions.lastElementChild).focus();
  });
}
modal.addEventListener('click', e => { if (e.target === modal && modalDone) modalDone(); });

// Closing the window with unsaved work asks first.
let closing = false;
appWindow.onCloseRequested(async e => {
  if (closing || !hasWork()) return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  let ok = false;
  try { ok = await guardUnsaved(); } finally { busy = false; }
  if (ok) { closing = true; await appWindow.destroy(); }
});

/* ───────── actions & keys ───────── */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  const act = a.dataset.action;
  if (act === 'new-board') exclusive(newBoard);
  else if (act === 'open-board') exclusive(() => openProject());
  else if (act === 'toggle-sidebar') toggleSidebar();
  else if (act === 'pin') togglePin();
  else if (act === 'toggle-theme') toggleTheme();
  else if (act === 'pick-files') { if (toastAction) { const f = toastAction; resetDock(); f(); } else filePick.click(); }
  else if (act === 'close-focus') closeFocus();
  else if (act === 'focus-prev') stepFocus(-1);
  else if (act === 'focus-next') stepFocus(1);
  else if (act === 'focus-copy') copyItem(boardItems()[focusIdx]);
  else if (act === 'focus-delete') removeItem(boardItems()[focusIdx]);
});

// The panel and the cards travel together: lay out once for the final width and let
// both transitions share the same duration and curve, instead of reflowing every frame.
let syncTimer = 0;
function toggleSidebar() {
  app.classList.toggle('collapsed');
  if (app.classList.contains('narrow')) return;
  localStorage.setItem('trove.collapsed', app.classList.contains('collapsed') ? '1' : '');
  const collapsed = app.classList.contains('collapsed');
  const stageW = innerWidth - cssNum('--inset') - (collapsed ? cssNum('--inset') : cssNum('--side-w'));
  app.classList.add('syncing');
  layout({ width: stageW - cssNum('--pad') * 2 });
  updateHeader();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { app.classList.remove('syncing'); layout(); }, cssNum('--t-side') * 1000 + 60);
}
const narrowMQ = matchMedia('(max-width: 860px)');
function applyNarrow() {
  const n = narrowMQ.matches;
  app.classList.toggle('narrow', n);
  if (n) app.classList.add('collapsed');
  else app.classList.toggle('collapsed', !!localStorage.getItem('trove.collapsed'));
  updateHeader();
}
narrowMQ.addEventListener('change', applyNarrow);

/* Keep on top: real in the Tauri build (needs core:window:allow-set-always-on-top) */
let onTop = false;
async function togglePin() {
  onTop = !onTop;
  const btn = $('#pinBtn');
  btn.classList.toggle('on', onTop); btn.setAttribute('aria-pressed', onTop);
  const win = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow();
  if (win) {
    try { await win.setAlwaysOnTop(onTop); toast(onTop ? 'Window stays on top' : 'Window no longer on top'); }
    catch (err) { console.warn(err); toast('Couldn’t pin the window'); }
  } else toast(onTop ? 'Pinned. Works in the desktop app' : 'Unpinned');
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; localStorage.setItem('trove.theme', next);
}

document.addEventListener('keydown', e => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const typing = e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]');
  const k = (e.key || '').toLowerCase(); // autofill can send keydowns without a key
  if (modal.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); modalDone && modalDone(); }
    else if (e.key === 'Tab') { // keep focus inside the dialog
      const btns = [...modal.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    }
    return;
  }
  // A reload would throw away the open project.
  if (e.key === 'F5' || (mod && k === 'r')) { e.preventDefault(); return; }
  if (mod && k === 's') { e.preventDefault(); exclusive(() => saveProject({ as: e.shiftKey })); return; }
  if (mod && k === 'o') { e.preventDefault(); exclusive(() => openProject()); return; }
  if (mod && k === 'n') { e.preventDefault(); exclusive(newBoard); return; }
  if (drag && drag.active && e.key === 'Escape') { e.preventDefault(); finishDrag(true); drag = null; return; }
  if (focus.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeFocus(); }
    else if (e.key === 'ArrowRight') stepFocus(1);
    else if (e.key === 'ArrowLeft') stepFocus(-1);
    else if (e.key === 'Delete' || e.key === 'Backspace') removeItem(boardItems()[focusIdx]);
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); togglePin(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setDensity(state.colTarget + 40, true); return; }
  if (mod && e.key === '-') { e.preventDefault(); setDensity(state.colTarget - 40, true); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); restore(); return; }
  if (e.key === 'Escape') closeMenu();
  if (state.hovered) {
    const it = byId(state.hovered);
    if (!it) return;
    if (e.key === ' ') { e.preventDefault(); openFocus(it.id); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeItem(it); state.hovered = null; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copyItem(it); }
  }
});

/* ───────── opening from the OS ───────── */
// Double-clicking a .trv (or "Open with") while Trove is running arrives here.
// Waits for boot and for any dialog or save in progress before switching.
let booted = null;
function openFromOs(path) {
  booted.then(function attempt() {
    if (busy) return setTimeout(attempt, 250);
    exclusive(() => openProject(path));
  });
}

/* ───────── boot ───────── */
booted = (async function boot() {
  const theme = localStorage.getItem('trove.theme'); if (theme) document.documentElement.dataset.theme = theme;
  applyNarrow();
  // Listen before asking for the launch file, so nothing slips between the two.
  await window.__TAURI__.event.listen('open-project', e => openFromOs(e.payload));
  // Open the file Trove was launched with, else the last board, else a new one.
  loadLibrary();
  const launch = await invoke('take_launch_path');
  const first = launch || library[0];
  let opened = null, problem = null;
  if (first) {
    try { opened = await invoke('project_open', { path: first }); }
    catch (e) { problem = errMsg(e); if (/no longer exists/.test(problem)) forgetBoard(first); }
  }
  loadProject(opened || await invoke('project_new'), opened ? first : null);
  if (opened) rememberBoard(first);
  measureHead();
  refreshLibrary(); // fills in the other boards' rows
  if (problem) toast(`Couldn’t ${launch ? 'open' : 'reopen'} ${baseName(first)}. ${problem}`);
  if (document.fonts) document.fonts.ready.then(measureHead);
  setInterval(renderHead, 30000);
})();
})();
