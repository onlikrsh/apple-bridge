// Small shared toolkit for the three apps: element building, icons, the
// window chrome (traffic lights), popovers, menus, alerts, toasts and the
// sync status badge. Plain DOM, no framework.

import * as lucide from 'lucide';

// ------------------------------------------------------------------ dom

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A Lucide icon (by its PascalCase name) as an inline SVG element. */
export function icon(name, cls = 'icon') {
  const node = lucide[name];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', cls);
  const children = node ? node[2] || [] : [];
  for (const [tag, attrs] of children) {
    const child = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.append(child);
  }
  return svg;
}

export function tool(iconName, title, onClick, extra = {}) {
  return h('button', { class: `tool ${extra.class || ''}`, title, 'aria-label': title, onclick: onClick, disabled: extra.disabled }, icon(iconName), extra.label ? h('span', { class: 'tool-label' }, extra.label) : null);
}

// --------------------------------------------------------------- window

function tlGlyph(path) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

/** Close / minimise / zoom, macOS style. */
export function trafficLights() {
  return h(
    'div',
    { class: 'traffic' },
    h('button', { class: 'close', title: 'Close', onclick: () => window.api.win.close() }, tlGlyph('M1.5 1.5l5 5M6.5 1.5l-5 5')),
    h('button', { class: 'min', title: 'Minimise', onclick: () => window.api.win.minimize() }, tlGlyph('M1 4h6')),
    h('button', { class: 'max', title: 'Zoom', onclick: () => window.api.win.toggleMaximize() }, tlGlyph('M2 6V2.2h3.8M6 2v3.8H2.2')),
  );
}

/** Focus state for the traffic lights, double-click-to-zoom, and the Ctrl shortcuts every Mac app has. */
export function initWindow() {
  const apply = (s) => {
    if (s.focused !== undefined) document.body.classList.toggle('inactive', !s.focused);
  };
  window.api.win.state().then(apply);
  window.api.win.onState(apply);
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('.toolbar') && !e.target.closest('button, input, .search, .segmented')) window.api.win.toggleMaximize();
  });
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'q') {
      e.preventDefault();
      window.api.win.close();
    } else if (k === 'm') {
      e.preventDefault();
      window.api.win.minimize();
    }
  });
}

// -------------------------------------------------------------- overlays

let openOverlay = null;

export function closeOverlay() {
  if (openOverlay) {
    const o = openOverlay;
    openOverlay = null;
    o.close();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openOverlay) {
    e.stopPropagation();
    closeOverlay();
  }
}, true);

function place(el, anchorRect, side, gap) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x;
  let y;
  if (side === 'right' || side === 'left') {
    x = side === 'right' ? anchorRect.right + gap : anchorRect.left - r.width - gap;
    if (x + r.width > vw - 8) x = anchorRect.left - r.width - gap;
    if (x < 8) x = anchorRect.right + gap;
    y = anchorRect.top + anchorRect.height / 2 - r.height / 2;
  } else {
    x = anchorRect.left + anchorRect.width / 2 - r.width / 2;
    y = side === 'top' ? anchorRect.top - r.height - gap : anchorRect.bottom + gap;
    if (y + r.height > vh - 8) y = anchorRect.top - r.height - gap;
  }
  x = Math.max(8, Math.min(x, vw - r.width - 8));
  y = Math.max(8, Math.min(y, vh - r.height - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  return { x, y, w: r.width, h: r.height };
}

/**
 * A popover with an arrow pointing at `anchor` (an element or a DOMRect).
 * Clicking outside or pressing Escape closes it and calls onClose.
 */
export function popover(anchor, content, { side = 'right', onClose = () => {}, width } = {}) {
  closeOverlay();
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const arrow = h('div', { class: 'arrow' });
  const el = h('div', { class: 'popover', style: width ? { width: `${width}px` } : {} }, arrow, content);
  const p = place(el, rect, side, 12);
  if (side === 'right' || side === 'left') {
    const ay = Math.max(14, Math.min(rect.top + rect.height / 2 - p.y - 7, p.h - 28));
    const leftOfAnchor = p.x + p.w <= rect.left + 1;
    Object.assign(arrow.style, { top: `${ay}px`, [leftOfAnchor ? 'right' : 'left']: '-7px' });
  } else {
    const ax = Math.max(14, Math.min(rect.left + rect.width / 2 - p.x - 7, p.w - 28));
    const below = p.y >= rect.bottom;
    Object.assign(arrow.style, { left: `${ax}px`, [below ? 'top' : 'bottom']: '-7px' });
  }
  const onDown = (e) => {
    if (!el.contains(e.target) && !e.target.closest('.menu')) closeOverlay();
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  openOverlay = {
    close() {
      document.removeEventListener('mousedown', onDown, true);
      el.remove();
      onClose();
    },
  };
  return el;
}

/** A macOS-style pull-down menu. items: {label, onClick, checked, disabled, shortcut} or 'sep'. */
export function menu(anchor, items, { align = 'left' } = {}) {
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const el = h('div', { class: 'menu' });
  for (const item of items) {
    if (item === 'sep') {
      el.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    el.append(
      h(
        'div',
        {
          class: `menu-item ${item.disabled ? 'disabled' : ''}`,
          onmouseup: () => {
            if (item.disabled) return;
            el.remove();
            document.removeEventListener('mousedown', onDown, true);
            item.onClick && item.onClick();
          },
        },
        h('span', { class: 'check-mark' }, item.checked ? '✓' : ''),
        item.swatch ? h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: item.swatch, flex: 'none' } }) : null,
        h('span', {}, item.label),
        item.shortcut ? h('span', { class: 'shortcut' }, item.shortcut) : null,
      ),
    );
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let x = align === 'right' ? rect.right - r.width : rect.left;
  let y = rect.bottom + 4;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, rect.top - r.height - 4);
  x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  const onDown = (e) => {
    if (!el.contains(e.target)) {
      el.remove();
      document.removeEventListener('mousedown', onDown, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  return el;
}

/** A macOS alert. Resolves to the clicked button's value (Escape = cancel). */
export function alert({ title, message = '', buttons = [{ label: 'OK', value: true, primary: true }], iconSrc }) {
  return new Promise((resolve) => {
    const done = (v) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(buttons.find((b) => b.cancel)?.value ?? null);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        done(buttons.find((b) => b.primary)?.value ?? null);
      }
    };
    const scrim = h(
      'div',
      { class: 'scrim' },
      h(
        'div',
        { class: 'alert', role: 'alertdialog' },
        iconSrc ? h('img', { class: 'alert-icon', src: iconSrc, alt: '' }) : null,
        h('h3', {}, title),
        message ? h('p', {}, message) : null,
        h('div', { class: 'alert-buttons' }, buttons.map((b) => h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.destructive ? 'destructive' : ''}`, onclick: () => done(b.value) }, b.label))),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
  });
}

let toastTimer;
export function toast(message, { error = false, ms = 4000 } = {}) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast ${error ? 'error' : ''}` }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ----------------------------------------------------------- sync badge

export function relativeTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Syncing…", "Updated 2 min ago", or a red "Sync failed" that explains itself. */
export function syncBadge(onClick) {
  const el = h('button', { class: 'sync tool', title: 'Sync with iCloud' });
  let status = { state: 'idle' };
  const render = () => {
    clear(el);
    el.className = `sync tool ${status.state}`;
    if (status.state === 'syncing' || status.state === 'pending') {
      el.append(icon('RefreshCw'), status.state === 'pending' ? 'Waiting to sync' : 'Syncing…');
    } else if (status.state === 'error') {
      el.append(icon('CircleAlert'), 'Sync failed');
      el.title = status.message || 'Sync failed';
    } else {
      el.append(icon('Cloud'), status.lastSync ? `Updated ${relativeTime(status.lastSync)}` : 'iCloud');
      el.title = 'Sync now';
    }
  };
  el.addEventListener('click', () => {
    if (status.state === 'error') toast(status.message || 'Sync failed', { error: true, ms: 8000 });
    onClick();
  });
  window.api.sync.status().then((s) => {
    status = s || status;
    render();
  });
  window.api.sync.onStatus((s) => {
    status = { ...status, ...s };
    render();
    if (s.state === 'error' && s.message) toast(s.message, { error: true, ms: 7000 });
  });
  setInterval(render, 30000);
  render();
  return el;
}

/** Resizable sidebar/column: drag the element's right edge. */
export function resizable(el, key, { min, max }) {
  const saved = Number(localStorage.getItem(`width:${key}`));
  if (saved) el.style.width = `${Math.max(min, Math.min(max, saved))}px`;
  const grip = h('div', { style: { position: 'absolute', top: 0, right: '-3px', width: '6px', height: '100%', cursor: 'col-resize', zIndex: 5 } });
  el.style.position = 'relative';
  el.append(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const move = (ev) => {
      el.style.width = `${Math.max(min, Math.min(max, startW + ev.clientX - startX))}px`;
    };
    const up = () => {
      localStorage.setItem(`width:${key}`, String(Math.round(el.getBoundingClientRect().width)));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
