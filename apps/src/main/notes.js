'use strict';
// The Notes app's view of an icloud-md vault: one Markdown file per note,
// folders as directories. Everything here must keep icloud-md's invariants:
//
//  * The YAML frontmatter at the top of a file is local-only and carries the
//    note's identity (`apple-note-id`). It is split off before the editor
//    sees a note and re-attached byte-for-byte on save, using exactly
//    icloud-md's own split rules (src/notes/frontmatter.ts).
//  * In the default "in-body" vault the title is the body's first line and
//    the file name is cosmetic. In a "filename" vault the file name is the
//    title; a retitle is requested through `apple-note-title` frontmatter
//    and the next pull renames the file.
//  * Notes with file attachments are read-only: icloud-md refuses to push
//    them, so the app never offers to edit them.

const fs = require('node:fs');
const path = require('node:path');

const FENCE = '---';
const SKIP_DIRS = new Set(['attachments', 'node_modules']);
const ATTACHMENT_REF = /\]\((?:\.\/)?attachments\/|!\[\[/;

function splitFrontmatter(text, filenameAsTitle = false) {
  const lines = text.split('\n');
  if (lines[0] !== FENCE) return { frontmatter: '', body: text };
  if (filenameAsTitle && (lines[1] === FENCE || lines[1] === '' || lines[1] === undefined)) {
    return { frontmatter: '', body: text };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      closing = i;
      break;
    }
  }
  if (closing === -1) return { frontmatter: '', body: text };
  let end = closing;
  if (filenameAsTitle) {
    if (lines[end + 1] === '') end += 1;
  } else {
    while (end + 1 < lines.length && lines[end + 1] === '') end += 1;
  }
  const bodyLines = lines.slice(end + 1);
  const envelope = lines.slice(0, end + 1).join('\n');
  return { frontmatter: bodyLines.length > 0 ? `${envelope}\n` : envelope, body: bodyLines.join('\n') };
}

function frontmatterValue(frontmatter, key) {
  const m = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return undefined;
  const raw = m[1].trim();
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Set (or add) one `key: "value"` line inside an existing envelope. */
function setFrontmatterValue(frontmatter, key, value) {
  const line = `${key}: ${JSON.stringify(value)}`;
  if (!frontmatter) return `${FENCE}\n${line}\n${FENCE}\n\n`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(frontmatter)) return frontmatter.replace(re, line);
  const lines = frontmatter.split('\n');
  const closing = lines.indexOf(FENCE, 1);
  lines.splice(closing, 0, line);
  return lines.join('\n');
}

/** Markdown line -> the plain text Notes would show in the list. */
function plainText(line) {
  // Hide escaped characters first, so `5\*` survives the emphasis stripping.
  const escaped = [];
  return line
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>=])/g, (_, ch) => `\u0000${escaped.push(ch) - 1}\u0000`)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?u>/g, '')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => escaped[Number(i)])
    .trim();
}

function isTableRule(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function describe(body, titleFromName) {
  const lines = body.split('\n');
  let title = titleFromName;
  let i = 0;
  if (title === undefined) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    title = i < lines.length ? plainText(lines[i]) : '';
    i += 1;
  }
  const rest = [];
  for (; i < lines.length && rest.join(' ').length < 160; i += 1) {
    if (lines[i].trim().startsWith('```') || isTableRule(lines[i])) continue;
    const text = plainText(lines[i].replace(/\|/g, ' ')).replace(/\s+/g, ' ');
    if (text) rest.push(text);
  }
  return { title: title || 'New Note', snippet: rest.join(' ').slice(0, 160) };
}

function safeName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || 'New Note';
}

class NotesVault {
  constructor(root) {
    this.root = path.resolve(root);
  }

  titleMode() {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.root, '.icloud-md', 'state.json'), 'utf8'));
      return state.titleMode === 'filename' ? 'filename' : 'in-body';
    } catch {
      return 'in-body';
    }
  }

  exists() {
    return fs.existsSync(path.join(this.root, '.icloud-md'));
  }

  /** Resolve a vault-relative path, refusing anything outside the vault. */
  abs(rel, { md = true } = {}) {
    if (typeof rel !== 'string' || path.isAbsolute(rel)) throw new Error('bad path');
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('path outside the vault');
    if (md && !full.endsWith('.md')) throw new Error('not a note');
    return full;
  }

  rel(full) {
    return path.relative(this.root, full).split(path.sep).join('/');
  }

  scan() {
    const filenameMode = this.titleMode() === 'filename';
    const folders = [];
    const notes = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          folders.push({ id: this.rel(full), name: e.name, depth, count: 0 });
          walk(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          notes.push(this.summary(full, filenameMode));
        }
      }
    };
    walk(this.root, 0);
    const counts = new Map();
    for (const n of notes) counts.set(n.folder, (counts.get(n.folder) || 0) + 1);
    for (const f of folders) f.count = counts.get(f.id) || 0;
    if (counts.get('')) folders.unshift({ id: '', name: folders.some((f) => f.name === 'Notes' && f.depth === 0) ? 'Other' : 'Notes', depth: 0, count: counts.get('') });
    notes.sort((a, b) => b.mtime - a.mtime);
    return { titleMode: filenameMode ? 'filename' : 'in-body', folders, notes };
  }

  summary(full, filenameMode) {
    const text = fs.readFileSync(full, 'utf8');
    const { frontmatter, body } = splitFrontmatter(text, filenameMode);
    const named = filenameMode ? frontmatterValue(frontmatter, 'apple-note-title') || path.basename(full, '.md') : undefined;
    const { title, snippet } = describe(body, named);
    const rel = this.rel(full);
    return {
      id: rel,
      search: `${title}\n${body}`.slice(0, 20000).toLowerCase(),
      folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      noteId: frontmatterValue(frontmatter, 'apple-note-id') || null,
      title,
      snippet,
      mtime: fs.statSync(full).mtimeMs,
      readOnly: ATTACHMENT_REF.test(body),
    };
  }

  read(id) {
    const full = this.abs(id);
    const filenameMode = this.titleMode() === 'filename';
    const { body } = splitFrontmatter(fs.readFileSync(full, 'utf8'), filenameMode);
    return { ...this.summary(full, filenameMode), body, titleMode: filenameMode ? 'filename' : 'in-body' };
  }

  /**
   * Save the editor's Markdown. In a filename vault the editor shows the title
   * as its first line, which is split off here: the lines after it are the
   * body exactly (empty first paragraphs included), and a changed title
   * becomes an `apple-note-title` request.
   */
  write(id, markdown, expectedMtime) {
    const full = this.abs(id);
    // A pull (from the app or the background timer) may have rewritten the
    // file since the editor loaded it. Writing over it would quietly revert
    // what came from the phone, so refuse and let the app reload instead.
    if (expectedMtime && Math.abs(fs.statSync(full).mtimeMs - expectedMtime) > 1) {
      const err = new Error('This note changed on another device. It has been reloaded.');
      err.code = 'CHANGED_ON_DISK';
      throw err;
    }
    const filenameMode = this.titleMode() === 'filename';
    const current = fs.readFileSync(full, 'utf8');
    let { frontmatter } = splitFrontmatter(current, filenameMode);
    let body = markdown;
    if (filenameMode) {
      const [first, ...rest] = markdown.split('\n');
      const title = plainText(first);
      const known = frontmatterValue(frontmatter, 'apple-note-title') || path.basename(full, '.md');
      if (title && title !== known) frontmatter = setFrontmatterValue(frontmatter, 'apple-note-title', title);
      body = rest.join('\n'); // the editor sends the title line, then the body as is
    }
    writeAtomic(full, frontmatter + body);
    return this.summary(full, filenameMode);
  }

  /** A new note: named after its first line, in `folder` ('' = vault root). */
  create(folder, markdown) {
    const dir = folder ? this.abs(folder, { md: false }) : this.root;
    fs.mkdirSync(dir, { recursive: true });
    const filenameMode = this.titleMode() === 'filename';
    const [first, ...rest] = markdown.split('\n');
    const name = uniqueName(dir, `${safeName(plainText(first))}.md`);
    const full = path.join(dir, name);
    writeAtomic(full, filenameMode ? rest.join('\n') : markdown);
    return this.summary(full, filenameMode);
  }

  /** Locally deleted notes go to Recently Deleted on the next push. */
  remove(id) {
    fs.unlinkSync(this.abs(id));
  }

  move(id, folder) {
    const from = this.abs(id);
    const dir = folder ? this.abs(folder, { md: false }) : this.root;
    fs.mkdirSync(dir, { recursive: true });
    const to = path.join(dir, uniqueName(dir, path.basename(from)));
    fs.renameSync(from, to);
    return this.rel(to);
  }

  createFolder(parent, name) {
    const clean = safeName(name);
    if (SKIP_DIRS.has(clean)) throw new Error(`"${clean}" is reserved`);
    const base = parent ? this.abs(parent, { md: false }) : this.root;
    const dir = path.join(base, clean);
    if (fs.existsSync(dir)) throw new Error(`A folder named "${clean}" already exists`);
    fs.mkdirSync(dir, { recursive: true });
    return this.rel(dir);
  }

  /** For <img> in read-only notes: an attachment's absolute path, if inside the vault. */
  attachmentPath(noteId, src) {
    const noteDir = path.dirname(this.abs(noteId));
    const full = path.resolve(noteDir, decodeURIComponent(src));
    return full.startsWith(this.root + path.sep) ? full : null;
  }
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) candidate = `${stem} ${n}${ext}`;
  return candidate;
}

function writeAtomic(full, content) {
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, full);
}

module.exports = { NotesVault, splitFrontmatter, frontmatterValue, setFrontmatterValue, plainText, describe, safeName };
