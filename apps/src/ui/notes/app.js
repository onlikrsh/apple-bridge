// Notes: folders | notes list | editor, like Notes on macOS.

import '../shared/mac.css';
import './notes.css';
import { h, clear, icon, tool, trafficLights, initWindow, popover, menu, closeOverlay, toast, syncBadge, resizable } from '../shared/ui.js';
import { createEditor, createReader, noteMarkdown, setNote } from './editor.js';
import { mergeEdit } from './merge.js';

const ALL = '*';
const state = {
  data: { folders: [], notes: [], configured: true },
  folder: localStorage.getItem('folder') || ALL,
  selected: null,
  query: '',
  current: null, // { id|null, folder, mtime, readOnly, dirty }
  listFocused: false,
};

let editor;
let readBack;
let saveTimer = null;
const els = {};

// ------------------------------------------------------------------ layout

function layout() {
  const root = document.getElementById('root');
  els.folders = h('div', { class: 'sidebar-scroll' });
  els.sidebar = h(
    'aside',
    { class: 'sidebar folders' },
    h('div', { class: 'toolbar' }, trafficLights(), h('div', { class: 'spacer' }), tool('PanelLeft', 'Hide sidebar', toggleSidebar)),
    els.folders,
    h('div', { class: 'sidebar-footer' }, h('button', { class: 'new-folder', onclick: () => newFolder() }, icon('CirclePlus'), 'New Folder')),
  );
  resizable(els.sidebar, 'notes-sidebar', { min: 160, max: 320 });

  els.listTitle = h('div', { class: 'toolbar-title' });
  els.listCount = h('div', { class: 'toolbar-subtitle' });
  els.showSidebar = tool('PanelLeft', 'Show sidebar', toggleSidebar, { class: 'only-collapsed' });
  els.list = h('div', { class: 'note-list', tabindex: '0', onfocus: () => setListFocus(true), onblur: () => setListFocus(false), onkeydown: listKeys });
  els.listCol = h(
    'section',
    { class: 'list-col' },
    h('div', { class: 'toolbar' }, h('div', { class: 'only-collapsed' }, trafficLights()), els.showSidebar, h('div', { class: 'list-heading' }, els.listTitle, els.listCount), h('div', { class: 'spacer' }), tool('Trash2', 'Delete note', () => deleteNote())),
    els.list,
  );
  resizable(els.listCol, 'notes-list', { min: 220, max: 460 });

  els.search = h('input', { type: 'search', placeholder: 'Search', oninput: (e) => setQuery(e.target.value), onkeydown: (e) => e.key === 'Escape' && setQuery('', true) });
  els.formatBtn = tool('Type', 'Format', (e) => formatPopover(e.currentTarget));
  els.checklistBtn = tool('ListChecks', 'Checklist (Ctrl+Shift+L)', () => editor && editor.chain().focus().toggleTaskList().run());
  els.tableBtn = tool('Table', 'Table', () => editor && editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
  els.linkBtn = tool('Link', 'Add link (Ctrl+K)', () => addLink());
  els.banner = h('div', { class: 'banner', hidden: true });
  els.date = h('div', { class: 'note-date-line' });
  els.editorHost = h('div', { class: 'editor-host' });
  els.editorScroll = h('div', { class: 'editor-scroll' }, els.date, els.editorHost);
  els.placeholder = h('div', { class: 'empty' }, '');
  els.editorCol = h(
    'main',
    { class: 'editor-col' },
    h(
      'div',
      { class: 'toolbar' },
      tool('SquarePen', 'New Note (Ctrl+N)', () => newNote()),
      h('div', { class: 'toolbar-gap' }),
      els.formatBtn,
      els.checklistBtn,
      els.tableBtn,
      els.linkBtn,
      h('div', { class: 'spacer' }),
      syncBadge(() => window.api.notes.sync()),
      h('label', { class: 'search' }, icon('Search'), els.search),
    ),
    els.banner,
    els.editorScroll,
    els.placeholder,
  );

  root.append(els.sidebar, els.listCol, els.editorCol);
  if (localStorage.getItem('sidebar') === 'hidden') document.body.classList.add('no-sidebar');
}

function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
  localStorage.setItem('sidebar', document.body.classList.contains('no-sidebar') ? 'hidden' : 'shown');
}

function setListFocus(on) {
  state.listFocused = on;
  els.list.classList.toggle('focused', on);
}

// ----------------------------------------------------------------- folders

function folderName(id) {
  if (id === ALL) return 'All iCloud';
  const f = state.data.folders.find((x) => x.id === id);
  return f ? f.name : 'Notes';
}

function defaultFolder() {
  if (state.folder !== ALL) return state.folder;
  const notes = state.data.folders.find((f) => f.depth === 0 && f.name === 'Notes');
  return notes ? notes.id : state.data.folders[0]?.id || '';
}

function renderFolders() {
  clear(els.folders);
  els.folders.append(h('div', { class: 'section-title' }, 'iCloud'));
  const total = state.data.notes.length;
  const rows = [{ id: ALL, name: 'All iCloud', depth: 0, count: total, icon: 'Archive' }, ...state.data.folders];
  for (const f of rows) {
    const row = h(
      'div',
      {
        class: `row folder ${state.folder === f.id && !state.query ? 'selected' : ''}`,
        style: { paddingLeft: `${8 + f.depth * 16}px` },
        onclick: () => selectFolder(f.id),
        ondragover: (e) => {
          if (f.id === ALL) return;
          e.preventDefault();
          row.classList.add('drop');
        },
        ondragleave: () => row.classList.remove('drop'),
        ondrop: (e) => {
          row.classList.remove('drop');
          const id = e.dataTransfer.getData('text/x-note');
          if (id && f.id !== ALL) moveNote(id, f.id);
        },
      },
      icon(f.icon || 'Folder', 'icon folder-icon'),
      h('span', { class: 'name' }, f.name),
      h('span', { class: 'count' }, f.count || ''),
    );
    els.folders.append(row);
  }
}

function selectFolder(id) {
  flushSave();
  state.folder = id;
  localStorage.setItem('folder', id);
  if (state.query) setQuery('', true);
  renderFolders();
  renderList();
  const first = visibleNotes()[0];
  if (first) openNote(first.id);
  else showNothing();
}

function newFolder(parent = '') {
  const input = h('input', { class: 'field folder-input', value: 'New Folder' });
  const row = h('div', { class: 'row folder editing' }, icon('Folder', 'icon folder-icon'), input);
  els.folders.append(row);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    row.remove();
    if (!commit || !name) return;
    try {
      const id = await window.api.notes.createFolder({ parent, name });
      await refresh();
      selectFolder(id);
    } catch (err) {
      toast(cleanError(err), { error: true });
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------------- list

function visibleNotes() {
  const q = state.query.trim().toLowerCase();
  let notes = state.data.notes;
  if (q) notes = notes.filter((n) => n.search.includes(q));
  else if (state.folder !== ALL) notes = notes.filter((n) => n.folder === state.folder);
  return notes;
}

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Notes' list sections: Today, Yesterday, Previous 7 Days, Previous 30 Days, month, year. */
function sectionFor(ms, now = new Date()) {
  const today = dayStart(now);
  const day = 86400000;
  if (ms >= today) return 'Today';
  if (ms >= today - day) return 'Yesterday';
  if (ms >= today - 7 * day) return 'Previous 7 Days';
  if (ms >= today - 30 * day) return 'Previous 30 Days';
  const d = new Date(ms);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'long' });
  return String(d.getFullYear());
}

function shortDate(ms, now = new Date()) {
  const d = new Date(ms);
  const today = dayStart(now);
  if (ms >= today) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (ms >= today - 86400000) return 'Yesterday';
  if (ms >= today - 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderList() {
  const notes = visibleNotes();
  const draft = state.current && !state.current.id && !state.query ? [{ id: null, title: 'New Note', snippet: 'No additional text', mtime: Date.now(), folder: state.current.folder, draft: true }] : [];
  const all = [...draft, ...notes];
  els.listTitle.textContent = state.query ? 'Search' : folderName(state.folder);
  els.listCount.textContent = `${all.length} note${all.length === 1 ? '' : 's'}`;
  clear(els.list);
  if (!state.data.configured) {
    els.list.append(h('div', { class: 'list-empty' }, 'Notes isn’t set up yet.'));
    return;
  }
  if (!all.length) {
    els.list.append(h('div', { class: 'list-empty' }, state.query ? 'No Results' : 'No Notes'));
    return;
  }
  let section = null;
  for (const n of all) {
    const s = sectionFor(n.mtime);
    if (s !== section) {
      section = s;
      els.list.append(h('div', { class: 'list-section' }, s));
    }
    const selected = n.draft ? !state.current.id : state.selected === n.id;
    const row = h(
      'div',
      {
        class: `note-row ${selected ? 'selected' : ''}`,
        draggable: !n.draft,
        onmousedown: () => !n.draft && n.id !== state.selected && openNote(n.id),
        oncontextmenu: (e) => !n.draft && noteMenu(e, n),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/x-note', n.id);
          e.dataTransfer.effectAllowed = 'move';
        },
      },
      h('div', { class: 'note-title' }, n.readOnly ? icon('Paperclip', 'icon clip') : null, n.title),
      h('div', { class: 'note-meta' }, h('span', { class: 'note-when' }, shortDate(n.mtime)), h('span', { class: 'note-snippet' }, n.snippet || 'No additional text')),
      state.folder === ALL || state.query ? h('div', { class: 'note-folder' }, icon('Folder', 'icon'), folderName(n.folder)) : null,
    );
    els.list.append(row);
  }
}

function listKeys(e) {
  const notes = visibleNotes();
  const i = notes.findIndex((n) => n.id === state.selected);
  if (e.key === 'ArrowDown' && i < notes.length - 1) {
    e.preventDefault();
    openNote(notes[i + 1].id);
  } else if (e.key === 'ArrowUp' && i > 0) {
    e.preventDefault();
    openNote(notes[i - 1].id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteNote();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    editor && editor.commands.focus('end');
  }
}

function noteMenu(e, n) {
  e.preventDefault();
  const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
  const targets = state.data.folders.filter((f) => f.id !== n.folder);
  menu(rect, [
    ...targets.map((f) => ({ label: `Move to “${f.name}”`, onClick: () => moveNote(n.id, f.id) })),
    ...(targets.length ? ['sep'] : []),
    { label: 'Delete', onClick: () => deleteNote(n.id) },
  ]);
}

function setQuery(q, clearField = false) {
  state.query = q;
  if (clearField) els.search.value = '';
  renderFolders();
  renderList();
}

// ------------------------------------------------------------------ notes

async function refresh() {
  state.data = await window.api.notes.scan();
  if (state.folder !== ALL && !state.data.folders.some((f) => f.id === state.folder)) state.folder = ALL;
  renderFolders();
  renderList();
}

function showNothing() {
  state.selected = null;
  state.current = null;
  els.editorScroll.hidden = true;
  els.banner.hidden = true;
  els.placeholder.hidden = false;
  els.placeholder.textContent = state.data.configured ? '' : '';
  if (!state.data.configured) {
    clear(els.placeholder).append(
      h('div', {}, h('div', { class: 'empty-title' }, 'Notes isn’t set up yet'), h('p', {}, 'In a terminal, run ', h('code', {}, 'abridge setup notes'), ' and sign in to iCloud.')),
    );
  }
  setTools(false);
}

function setTools(on, readOnly = false) {
  for (const b of [els.formatBtn, els.checklistBtn, els.tableBtn, els.linkBtn]) b.disabled = !on || readOnly;
}

function noteDateLine(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Image links in read-only notes point into the vault through the vault:// protocol. */
function withVaultImages(markdown, noteId) {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) =>
    /^[a-z]+:/i.test(src) ? m : `![${alt}](vault://note/?note=${encodeURIComponent(noteId)}&src=${encodeURIComponent(src)})`,
  );
}

async function openNote(id) {
  flushSave();
  let note;
  try {
    note = await window.api.notes.read(id);
  } catch (err) {
    toast(cleanError(err), { error: true });
    await refresh();
    return;
  }
  state.selected = id;
  state.current = { id, folder: note.folder, mtime: note.mtime, readOnly: note.readOnly, dirty: false, titleMode: note.titleMode };
  const md = note.titleMode === 'filename' ? `# ${note.title}\n${note.body}` : note.body;
  state.current.original = md; // the file as it is, which a save edits rather than replaces
  editor.setEditable(!note.readOnly);
  setNote(editor, note.readOnly ? withVaultImages(md, id) : md);
  // What saving this note unchanged would write. Loading can fire update
  // events (the editor normalises the document); only a real difference
  // from this baseline is ever saved.
  state.current.baseline = noteMarkdown(editor);
  els.date.textContent = noteDateLine(note.mtime);
  els.banner.hidden = !note.readOnly;
  if (note.readOnly) {
    clear(els.banner).append(icon('Paperclip'), 'This note has attachments, so it’s view-only on Linux. Edit it on your iPhone.');
  }
  els.editorScroll.hidden = false;
  els.placeholder.hidden = true;
  els.editorScroll.scrollTop = 0;
  setTools(true, note.readOnly);
  renderList();
  const row = els.list.querySelector('.note-row.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function newNote() {
  flushSave();
  if (!state.data.configured) return;
  if (state.query) setQuery('', true);
  state.selected = null;
  state.current = { id: null, folder: defaultFolder(), mtime: null, readOnly: false, dirty: false };
  editor.setEditable(true);
  editor.commands.setContent('<h1></h1>', false);
  state.current.baseline = noteMarkdown(editor);
  els.date.textContent = noteDateLine(Date.now());
  els.banner.hidden = true;
  els.editorScroll.hidden = false;
  els.placeholder.hidden = true;
  setTools(true);
  renderList();
  editor.commands.focus('start');
}

function scheduleSave() {
  if (!state.current || state.current.readOnly) return;
  state.current.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    save();
  }
}

let saving = Promise.resolve();
function save() {
  saveTimer = null;
  const cur = state.current;
  if (!cur || !cur.dirty) return saving;
  const edited = noteMarkdown(editor);
  cur.dirty = false;
  if (edited === cur.baseline) return saving;
  // Write only what changed (merge.js): the editor's own Markdown would also
  // rewrite blank lines, table padding and spaces the user never touched.
  // If the merged text wouldn't read back as the editor shows it, write the
  // editor's Markdown as before.
  const merged = mergeEdit(cur.original, cur.baseline, edited);
  const markdown = merged === edited || readBack(merged) === edited ? merged : edited;
  cur.baseline = edited;
  cur.original = markdown;
  saving = saving.then(async () => {
    try {
      let summary;
      if (cur.id) {
        summary = await window.api.notes.write({ id: cur.id, markdown, mtime: cur.mtime });
      } else {
        if (!markdown.trim()) return; // an empty new note is never written
        summary = await window.api.notes.create({ folder: cur.folder, markdown });
        cur.id = summary.id;
        if (state.current === cur) state.selected = summary.id;
      }
      cur.mtime = summary.mtime;
      const i = state.data.notes.findIndex((n) => n.id === summary.id);
      if (i >= 0) state.data.notes.splice(i, 1);
      state.data.notes.unshift(summary);
      bumpCounts();
      renderList();
    } catch (err) {
      const msg = cleanError(err);
      toast(msg, { error: true });
      if (/changed on another device/i.test(msg) && cur.id) {
        await refresh();
        if (state.current === cur) openNote(cur.id);
      }
    }
  });
  return saving;
}

function bumpCounts() {
  const counts = new Map();
  for (const n of state.data.notes) counts.set(n.folder, (counts.get(n.folder) || 0) + 1);
  for (const f of state.data.folders) f.count = counts.get(f.id) || 0;
  renderFolders();
}

async function deleteNote(id = state.selected) {
  if (!id) {
    if (state.current && !state.current.id) showNext(-1);
    return;
  }
  const notes = visibleNotes();
  const index = notes.findIndex((n) => n.id === id);
  try {
    if (state.current && state.current.id === id) {
      clearTimeout(saveTimer);
      saveTimer = null;
      state.current.dirty = false;
    }
    await saving;
    await window.api.notes.remove(id);
  } catch (err) {
    toast(cleanError(err), { error: true });
    return;
  }
  state.data.notes = state.data.notes.filter((n) => n.id !== id);
  bumpCounts();
  toast('Moved to Recently Deleted');
  if (id === state.selected) showNext(index);
  else renderList();
}

function showNext(index) {
  const notes = visibleNotes();
  const next = notes[Math.min(Math.max(index, 0), notes.length - 1)];
  state.current = null;
  state.selected = null;
  if (next) openNote(next.id);
  else {
    renderList();
    showNothing();
  }
}

async function moveNote(id, folder) {
  if (state.current && state.current.id === id) await (flushSave(), saving);
  try {
    const newId = await window.api.notes.move({ id, folder });
    await refresh();
    if (state.selected === id) {
      state.selected = newId;
      if (state.current) state.current.id = newId;
    }
    renderList();
    toast(`Moved to “${folderName(folder)}”`);
  } catch (err) {
    toast(cleanError(err), { error: true });
  }
}

function cleanError(err) {
  return String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ----------------------------------------------------------------- format

const STYLES = [
  { label: 'Title', test: (e) => e.isActive('heading', { level: 1 }), run: (c) => c.setNode('heading', { level: 1 }), key: 'Ctrl+Shift+T' },
  { label: 'Heading', test: (e) => e.isActive('heading', { level: 2 }), run: (c) => c.setNode('heading', { level: 2 }), key: 'Ctrl+Shift+H' },
  { label: 'Subheading', test: (e) => e.isActive('heading', { level: 3 }), run: (c) => c.setNode('heading', { level: 3 }), key: 'Ctrl+Shift+J' },
  { label: 'Body', test: (e) => e.isActive('paragraph') && !e.isActive('bulletList') && !e.isActive('orderedList') && !e.isActive('taskList'), run: (c) => c.setParagraph(), key: 'Ctrl+Shift+B' },
  { label: 'Monostyled', test: (e) => e.isActive('codeBlock'), run: (c) => c.toggleCodeBlock(), key: 'Ctrl+Shift+M' },
  'sep',
  { label: '•  Bulleted List', test: (e) => e.isActive('bulletList'), run: (c) => c.toggleBulletList(), key: 'Ctrl+Shift+7' },
  { label: '1.  Numbered List', test: (e) => e.isActive('orderedList'), run: (c) => c.toggleOrderedList(), key: 'Ctrl+Shift+9' },
  'sep',
  { label: '│  Block Quote', test: (e) => e.isActive('blockquote'), run: (c) => c.toggleBlockquote(), key: 'Ctrl+\'' },
];

function formatPopover(anchor) {
  if (!editor) return;
  const mark = (name, label, title, run) =>
    h('button', { class: `fmt-btn ${editor.isActive(name) ? 'on' : ''}`, title, onmousedown: (e) => e.preventDefault(), onclick: () => (run(editor.chain().focus()).run(), formatPopover(anchor)) }, label);
  const body = h(
    'div',
    { class: 'format' },
    h(
      'div',
      { class: 'fmt-row' },
      mark('bold', h('b', {}, 'B'), 'Bold (Ctrl+B)', (c) => c.toggleBold()),
      mark('italic', h('i', {}, 'I'), 'Italic (Ctrl+I)', (c) => c.toggleItalic()),
      mark('underline', h('u', {}, 'U'), 'Underline (Ctrl+U)', (c) => c.toggleUnderline()),
      mark('strike', h('s', {}, 'S'), 'Strikethrough (Ctrl+Shift+X)', (c) => c.toggleStrike()),
    ),
    STYLES.map((s) =>
      s === 'sep'
        ? h('div', { class: 'menu-sep' })
        : h(
            'div',
            { class: `fmt-style ${s.label.toLowerCase()} ${s.test(editor) ? 'on' : ''}`, onmousedown: (e) => e.preventDefault(), onclick: () => (s.run(editor.chain().focus()).run(), closeOverlay()) },
            h('span', { class: 'check-mark' }, s.test(editor) ? '✓' : ''),
            h('span', { class: 'fmt-label' }, s.label),
          ),
    ),
  );
  popover(anchor, body, { side: 'bottom', width: 230 });
}

function addLink() {
  if (!editor || !state.current || state.current.readOnly) return;
  const prev = editor.getAttributes('link').href || 'https://';
  const input = h('input', { class: 'field', value: prev, style: { width: '260px' } });
  const apply = () => {
    const url = input.value.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    (url && url !== 'https://' ? chain.setLink({ href: url }) : chain.unsetLink()).run();
    closeOverlay();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
  popover(els.linkBtn, h('div', { class: 'link-pop' }, h('div', { class: 'pop-label' }, 'Link'), input, h('div', { class: 'pop-actions' }, h('button', { class: 'btn primary', onclick: apply }, 'OK'))), { side: 'bottom' });
  input.focus();
  input.select();
}

// ------------------------------------------------------------------- keys

function globalKeys(e) {
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const run = (fn) => {
    e.preventDefault();
    fn();
  };
  if (k === 'n' && e.shiftKey) run(() => newFolder());
  else if (k === 'n') run(newNote);
  else if (k === 'f') run(() => els.search.focus());
  else if (k === 'r') run(() => window.api.notes.sync());
  else if (k === 'backspace' && !e.shiftKey && document.activeElement === els.list) run(() => deleteNote());
  else if (k === 'k') run(addLink);
  else if (editor && e.shiftKey && state.current && !state.current.readOnly) {
    const style = { t: 0, h: 1, j: 2, b: 3, m: 4 }[k];
    if (style !== undefined) run(() => STYLES[style].run(editor.chain().focus()).run());
    else if (k === 'l') run(() => editor.chain().focus().toggleTaskList().run());
  }
}

// ------------------------------------------------------------------- boot

async function boot() {
  layout();
  initWindow();
  editor = createEditor(els.editorHost, { onUpdate: scheduleSave });
  readBack = createReader();
  window.__abridge = { editor, state }; // for the end-to-end tests
  document.addEventListener('keydown', globalKeys);
  window.api.notes.onChanged(async () => {
    const cur = state.current;
    await refresh();
    if (cur && cur.id && !cur.dirty && !saveTimer) {
      const fresh = state.data.notes.find((n) => n.id === cur.id);
      if (fresh && Math.abs(fresh.mtime - cur.mtime) > 1) openNote(cur.id);
      else if (!fresh) showNext(0);
    }
  });
  // Closing the window waits for the last edit to reach the disk.
  window.addEventListener('beforeunload', (e) => {
    const cur = state.current;
    if (!cur || !cur.dirty || cur.readOnly || noteMarkdown(editor) === cur.baseline) return;
    e.preventDefault();
    e.returnValue = false;
    flushSave();
    saving.then(() => window.api.win.close());
  });
  await refresh();
  const first = visibleNotes()[0];
  if (first) openNote(first.id);
  else showNothing();
}

boot();
