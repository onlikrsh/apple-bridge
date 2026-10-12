// Reminders: smart lists and your lists, like Reminders on macOS.

import '../shared/mac.css';
import './reminders.css';
import { h, clear, icon, tool, trafficLights, initWindow, popover, menu, closeOverlay, toast, syncBadge, resizable } from '../shared/ui.js';
import { SMART, counts, sections, dueText, dueDay, isOverdue, priorityMarks, priorityName, dueArg, todayKey } from './model.js';

const state = {
  data: { lists: [], reminders: [] },
  view: localStorage.getItem('view') || 'today',
  showCompleted: false,
  query: '',
  loaded: false,
  error: null,
  selected: null,
};
const els = {};
let tempId = 0;

// ------------------------------------------------------------------ layout

function layout() {
  els.search = h('input', { type: 'search', placeholder: 'Search', oninput: (e) => ((state.query = e.target.value), render()) });
  els.tiles = h('div', { class: 'tiles' });
  els.lists = h('div', { class: 'lists' });
  els.sidebar = h(
    'aside',
    { class: 'sidebar rem-sidebar' },
    h('div', { class: 'toolbar' }, trafficLights()),
    h('div', { class: 'rem-search' }, h('label', { class: 'search' }, icon('Search'), els.search)),
    h('div', { class: 'sidebar-scroll' }, els.tiles, h('div', { class: 'section-title' }, 'My Lists'), els.lists),
    h(
      'div',
      { class: 'sidebar-footer' },
      h('button', { class: 'add-list', disabled: true, title: 'Apple’s iCloud web API can’t create lists. Make new lists on your iPhone; they appear here on the next sync.' }, icon('CirclePlus'), 'Add List'),
    ),
  );
  resizable(els.sidebar, 'rem-sidebar', { min: 220, max: 340 });

  els.title = h('div', { class: 'rem-title' });
  els.count = h('div', { class: 'rem-count' });
  els.sub = h('div', { class: 'rem-sub' });
  els.body = h('div', { class: 'rem-body', onmousedown: (e) => e.target === els.body && startAdd() });
  els.main = h(
    'main',
    { class: 'rem-main' },
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'spacer' }),
      syncBadge(() => reload()),
      tool('Plus', 'New Reminder (Ctrl+N)', () => startAdd()),
      tool('Ellipsis', 'View options', (e) => viewMenu(e.currentTarget)),
    ),
    h('div', { class: 'rem-head' }, els.title, els.count),
    els.sub,
    els.body,
  );
  document.getElementById('root').append(els.sidebar, els.main);
}

function viewMenu(anchor) {
  menu(anchor, [{ label: state.showCompleted ? 'Hide Completed' : 'Show Completed', onClick: toggleCompleted }, 'sep', { label: 'Refresh', shortcut: 'Ctrl+R', onClick: () => reload() }], { align: 'right' });
}

async function toggleCompleted() {
  state.showCompleted = !state.showCompleted;
  render();
  if (state.showCompleted && !state.data.completedIncluded) await reload();
}

// ----------------------------------------------------------------- sidebar

function currentList() {
  return state.data.lists.find((l) => l.id === state.view) || null;
}

function viewMeta() {
  const smart = SMART.find((s) => s.id === state.view);
  if (smart) return { title: smart.label, color: smart.color };
  const list = currentList();
  return list ? { title: list.title, color: list.color || '#007AFF' } : { title: 'Reminders', color: '#007AFF' };
}

function renderSidebar() {
  const c = counts(state.data);
  clear(els.tiles);
  for (const s of SMART) {
    const on = state.view === s.id && !state.query;
    const glyph = s.id === 'today' ? h('span', { class: 'tile-day' }, new Date().getDate()) : icon(s.icon);
    els.tiles.append(
      h(
        'button',
        { class: `tile ${on ? 'on' : ''} ${s.id === 'completed' ? 'wide' : ''}`, style: { '--c': s.color }, onclick: () => setView(s.id) },
        h('span', { class: 'tile-icon' }, glyph),
        h('span', { class: 'tile-count' }, s.id === 'completed' ? '' : c[s.id]),
        h('span', { class: 'tile-label' }, s.label),
      ),
    );
  }
  clear(els.lists);
  for (const l of state.data.lists) {
    const open = state.data.reminders.filter((r) => r.list_id === l.id && !r.completed).length;
    els.lists.append(
      h(
        'div',
        { class: `row list-row ${state.view === l.id && !state.query ? 'selected' : ''}`, onclick: () => setView(l.id) },
        h('span', { class: 'list-icon', style: { background: l.color || '#007AFF' } }, icon('List')),
        h('span', { class: 'name' }, l.title),
        h('span', { class: 'count' }, open),
      ),
    );
  }
}

function setView(id) {
  state.view = id;
  state.query = '';
  els.search.value = '';
  state.selected = null;
  localStorage.setItem('view', id);
  closeOverlay();
  render();
  if (id === 'completed' && !state.data.completedIncluded) reload(true);
}

// -------------------------------------------------------------------- main

function render() {
  renderSidebar();
  const meta = state.query ? { title: `Results for “${state.query}”`, color: 'var(--text)' } : viewMeta();
  els.main.style.setProperty('--list', meta.color);
  els.title.textContent = meta.title;
  const secs = sections(state.data, state.view, { showCompleted: state.showCompleted || state.view === 'completed', query: state.query });
  const total = secs.reduce((n, s) => n + s.items.filter((r) => !r.completed || state.view === 'completed').length, 0);
  els.count.textContent = state.query ? '' : total;
  const doneHere = state.view === 'completed' || state.query ? 0 : state.data.reminders.filter((r) => r.completed && inView(r)).length;
  clear(els.sub);
  if (state.view !== 'completed' && !state.query && state.data.completedIncluded) {
    els.sub.append(`${doneHere} Completed`, ' · ', h('button', { class: 'link', onclick: toggleCompleted }, state.showCompleted ? 'Hide' : 'Show'));
  } else if (state.view !== 'completed' && !state.query) {
    els.sub.append(h('button', { class: 'link', onclick: toggleCompleted }, state.showCompleted ? 'Hide Completed' : 'Show Completed'));
  }

  clear(els.body);
  if (state.error && !state.loaded) {
    els.body.append(h('div', { class: 'empty' }, h('div', {}, h('div', { class: 'empty-title' }, 'Can’t reach iCloud Reminders'), h('p', {}, state.error), h('p', {}, 'If you haven’t signed in yet, run ', h('code', {}, 'abridge setup reminders'), '.'))));
    return;
  }
  if (!state.loaded && !state.data.reminders.length) {
    els.body.append(h('div', { class: 'empty' }, 'Loading…'));
    return;
  }
  for (const sec of secs) {
    if (sec.title) els.body.append(h('div', { class: 'rem-section', style: sec.color ? { color: sec.color } : {} }, sec.title));
    const ul = h('div', { class: 'rem-items' });
    for (const r of sec.items) ul.append(row(r));
    els.body.append(ul);
  }
  if (!secs.some((s) => s.items.length) && !state.query) {
    els.body.append(h('div', { class: 'rem-none' }, state.view === 'completed' ? 'No Completed Reminders' : 'No Reminders'));
  }
}

function inView(r) {
  if (state.view === 'all') return true;
  if (state.view === 'flagged') return r.flagged;
  if (state.view === 'today' || state.view === 'scheduled') return !!r.due && (state.view === 'scheduled' || dueDay(r) === todayKey());
  return r.list_id === state.view;
}

function listColor(r) {
  const l = state.data.lists.find((x) => x.id === r.list_id);
  return (l && l.color) || '#007AFF';
}

function row(r) {
  const color = listColor(r);
  const circle = h('button', { class: `circle ${r.completed ? 'done' : ''}`, title: r.completed ? 'Mark as not completed' : 'Mark as completed', onclick: (e) => (e.stopPropagation(), toggleDone(r)) });
  const meta = [];
  if (r.notes) meta.push(h('div', { class: 'rem-notes' }, r.notes));
  const dueBits = [];
  if (r.due) dueBits.push(h('span', { class: isOverdue(r) ? 'overdue' : '' }, dueText(r)));
  if (state.view !== r.list_id && !['completed'].includes(state.view) && (state.view === 'today' || state.view === 'scheduled' || state.query)) {
    const l = state.data.lists.find((x) => x.id === r.list_id);
    if (l) dueBits.push(h('span', { class: 'rem-list-name' }, l.title));
  }
  if (dueBits.length) meta.push(h('div', { class: 'rem-due' }, dueBits));
  const el = h(
    'div',
    {
      class: `rem-row ${r.completed ? 'completed' : ''} ${state.selected === r.id ? 'selected' : ''} ${r.depth ? 'sub' : ''}`,
      style: { '--c': color },
      dataset: { id: r.id },
      onmousedown: (e) => {
        if (e.target.closest('button, input, textarea')) return;
        state.selected = r.id;
        document.querySelectorAll('.rem-row.selected').forEach((n) => n.classList.remove('selected'));
        el.classList.add('selected');
      },
      ondblclick: (e) => !e.target.closest('button') && openInfo(r, el),
      oncontextmenu: (e) => {
        e.preventDefault();
        menu(new DOMRect(e.clientX, e.clientY, 0, 0), [
          { label: 'Show Info', onClick: () => openInfo(r, el) },
          { label: r.flagged ? 'Unflag' : 'Flag', onClick: () => edit(r, { flagged: !r.flagged }) },
          'sep',
          { label: 'Delete', onClick: () => remove(r) },
        ]);
      },
    },
    circle,
    h(
      'div',
      { class: 'rem-text' },
      h('div', { class: 'rem-line' }, r.priority ? h('span', { class: 'prio' }, priorityMarks(r.priority)) : null, h('span', { class: 'rem-title-text' }, r.title)),
      meta,
    ),
    r.flagged ? h('span', { class: 'flag' }, icon('Flag')) : null,
    h('button', { class: 'info', title: 'Show info', onclick: (e) => (e.stopPropagation(), openInfo(r, el)) }, icon('Info')),
  );
  return el;
}

// ------------------------------------------------------------------ actions

function cleanError(err) {
  return String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function mutate(promise, undo) {
  const result = await promise.catch((err) => ({ ok: false, message: cleanError(err) }));
  if (!result.ok) {
    toast(result.message || 'iCloud didn’t accept the change', { error: true });
    if (undo) undo();
    render();
  }
  return result;
}

async function toggleDone(r) {
  const was = r.completed;
  const target = state.data.reminders.find((x) => x.id === r.id);
  if (!target) return;
  target.completed = !was;
  render();
  if (!was && !state.showCompleted && state.view !== 'completed') {
    // Like Reminders: the ticked row lingers a moment before it goes.
    const el = els.body.querySelector(`.rem-row[data-id="${CSS.escape(r.id)}"]`);
    if (el) {
      el.classList.add('completed', 'leaving');
      setTimeout(() => render(), 1300);
    }
  }
  if (String(r.id).startsWith('tmp-')) return;
  await mutate(window.api.reminders.done({ id: r.id, done: !was }), () => (target.completed = was));
}

async function edit(r, fields) {
  const target = state.data.reminders.find((x) => x.id === r.id);
  if (!target) return;
  const before = { ...target };
  if (fields.title !== undefined) target.title = fields.title;
  if (fields.notes !== undefined) target.notes = fields.notes;
  if (fields.flagged !== undefined) target.flagged = fields.flagged;
  if (fields.priority !== undefined) target.priority = { high: 1, medium: 5, low: 9, none: 0 }[fields.priority];
  if (fields.due !== undefined) {
    if (fields.due === null) Object.assign(target, { due: null, all_day: false });
    else if (fields.due.length === 10) Object.assign(target, { due: `${fields.due}T00:00:00+00:00`, all_day: true });
    else Object.assign(target, { due: new Date(fields.due.replace(' ', 'T')).toISOString(), all_day: false });
  }
  render();
  const res = await mutate(window.api.reminders.edit({ id: r.id, ...fields }), () => Object.assign(target, before));
  if (res.ok) reload();
}

async function remove(r) {
  const idx = state.data.reminders.findIndex((x) => x.id === r.id);
  if (idx < 0) return;
  const [removed] = state.data.reminders.splice(idx, 1);
  render();
  await mutate(window.api.reminders.remove(r.id), () => state.data.reminders.splice(idx, 0, removed));
}

function defaultListId() {
  if (currentList()) return state.view;
  const saved = localStorage.getItem('default-list');
  return (state.data.lists.find((l) => l.id === saved) || state.data.lists.find((l) => l.title === 'Reminders') || state.data.lists[0] || {}).id;
}

/** Inline add, like clicking under the last reminder on a Mac. */
function startAdd() {
  if (!state.data.lists.length) return;
  closeOverlay();
  const existing = els.body.querySelector('.rem-row.adding input');
  if (existing) return existing.focus();
  const listId = defaultListId();
  const color = (state.data.lists.find((l) => l.id === listId) || {}).color || '#007AFF';
  const input = h('input', { class: 'add-input', placeholder: '' });
  const el = h('div', { class: 'rem-row adding', style: { '--c': color } }, h('span', { class: 'circle' }), h('div', { class: 'rem-text' }, input));
  let list = els.body.querySelector('.rem-items:last-of-type');
  if (!list) {
    list = h('div', { class: 'rem-items' });
    els.body.querySelector('.rem-none')?.remove();
    els.body.append(list);
  }
  list.append(el);
  input.focus();
  let finished = false;
  const commit = async (again) => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    el.remove();
    if (title) await add(listId, title);
    if (again && title) startAdd();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') {
      finished = true;
      el.remove();
    }
  });
  input.addEventListener('blur', () => commit(false));
}

async function add(listId, title) {
  const extra = {};
  if (state.view === 'today' || state.view === 'scheduled') extra.due = todayKey();
  if (state.view === 'flagged') extra.flagged = true;
  const local = {
    id: `tmp-${++tempId}`, short: '', list_id: listId, title, notes: '', completed: false, completed_date: null,
    due: extra.due ? `${extra.due}T00:00:00+00:00` : null, all_day: !!extra.due, due_label: '', priority: 0, flagged: !!extra.flagged,
    parent_id: null, created: new Date().toISOString(), modified: new Date().toISOString(),
  };
  state.data.reminders.push(local);
  render();
  const res = await mutate(window.api.reminders.add({ listId, title, ...extra }), () => (state.data.reminders = state.data.reminders.filter((r) => r !== local)));
  if (res.ok) reload();
}

// --------------------------------------------------------------------- info

function openInfo(r, anchorEl) {
  const dueOn = h('input', { type: 'checkbox', class: 'switch', checked: !!r.due });
  const day = h('input', { type: 'date', class: 'field', value: dueDay(r) || todayKey() });
  const timeOn = h('input', { type: 'checkbox', class: 'switch', checked: !!r.due && !r.all_day });
  const time = h('input', { type: 'time', class: 'field', value: r.due && !r.all_day ? new Date(r.due).toTimeString().slice(0, 5) : '09:00' });
  const flag = h('input', { type: 'checkbox', class: 'switch', checked: r.flagged, style: { '--switch-color': '#FF9500' } });
  const prio = h('select', { class: 'field' }, ['none', 'low', 'medium', 'high'].map((p) => h('option', { value: p, selected: priorityName(r.priority) === p }, p[0].toUpperCase() + p.slice(1))));
  const title = h('input', { class: 'info-title', value: r.title });
  const notes = h('textarea', { class: 'info-notes', rows: 2, placeholder: 'Notes' });
  notes.value = r.notes || '';
  const list = state.data.lists.find((l) => l.id === r.list_id);
  const sync = () => {
    day.disabled = !dueOn.checked;
    timeOn.disabled = !dueOn.checked;
    time.disabled = !dueOn.checked || !timeOn.checked;
  };
  dueOn.addEventListener('change', sync);
  timeOn.addEventListener('change', sync);
  sync();
  const line = (label, ...rest) => h('div', { class: 'info-line' }, h('span', { class: 'info-label' }, label), h('div', { class: 'info-ctl' }, ...rest));
  const body = h(
    'div',
    { class: 'info-pop' },
    title,
    notes,
    h('div', { class: 'info-group' }, h('div', { class: 'info-head' }, 'Remind me'), line('On a Day', dueOn, day), line('At a Time', timeOn, time)),
    h('div', { class: 'info-group' }, line('Flagged', flag), line('Priority', prio), line('List', h('span', { class: 'info-list' }, h('span', { class: 'swatch', style: { background: (list && list.color) || '#007AFF' } }), list ? list.title : ''))),
    h('div', { class: 'info-actions' }, h('button', { class: 'btn destructive', onclick: () => ((dropped = true), closeOverlay(), remove(r)) }, 'Delete')),
  );
  let dropped = false;
  popover(anchorEl.querySelector('.info') || anchorEl, body, {
    side: 'left',
    width: 300,
    onClose: () => {
      if (dropped) return;
      const fields = {};
      if (title.value.trim() && title.value.trim() !== r.title) fields.title = title.value.trim();
      if (notes.value !== (r.notes || '')) fields.notes = notes.value;
      const newDue = dueOn.checked ? dueArg(day.value, timeOn.checked ? time.value : null) : null;
      const oldDue = r.due ? dueArg(dueDay(r), r.all_day ? null : new Date(r.due).toTimeString().slice(0, 5)) : null;
      if (newDue !== oldDue) fields.due = newDue;
      if (flag.checked !== !!r.flagged) fields.flagged = flag.checked;
      if (prio.value !== priorityName(r.priority)) fields.priority = prio.value;
      if (Object.keys(fields).length) edit(r, fields);
    },
  });
  title.focus();
}

// --------------------------------------------------------------------- data

let reloading = null;
async function reload(force = false) {
  if (reloading && !force) return reloading;
  reloading = (async () => {
    const data = await window.api.reminders.load({ completed: state.showCompleted || state.view === 'completed' });
    if (data && !data.error) {
      state.data = data;
      state.loaded = true;
      state.error = null;
      if (!SMART.some((s) => s.id === state.view) && !data.lists.some((l) => l.id === state.view)) state.view = 'today';
    } else if (data && data.error) {
      state.error = data.error;
    }
    if (!document.querySelector('.popover, .rem-row.adding, .rem-row.leaving')) render();
  })();
  try {
    await reloading;
  } finally {
    reloading = null;
  }
}

function keys(e) {
  if (e.target.closest('input, textarea, select, .popover')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey) {
    if (k === 'n') return e.preventDefault(), startAdd();
    if (k === 'f') return e.preventDefault(), els.search.focus();
    if (k === 'r') return e.preventDefault(), reload();
  }
  if ((k === 'delete' || k === 'backspace') && state.selected) {
    const r = state.data.reminders.find((x) => x.id === state.selected);
    if (r) remove(r);
  }
}

async function boot() {
  layout();
  initWindow();
  document.addEventListener('keydown', keys);
  const cached = await window.api.reminders.cached();
  if (cached && cached.lists) {
    state.data = cached;
    state.data.completedIncluded = false;
  }
  render();
  await reload();
  window.__abridge = { state, reload }; // for the end-to-end tests
  setInterval(() => document.hasFocus() && reload(), 3 * 60 * 1000);
}

boot();
