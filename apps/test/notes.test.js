'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NotesVault, splitFrontmatter, plainText, describe } = require('../src/main/notes');

function vault(mode = 'in-body') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(root, '.icloud-md'));
  fs.writeFileSync(path.join(root, '.icloud-md', 'state.json'), JSON.stringify({ titleMode: mode }));
  return { root, v: new NotesVault(root) };
}

const FM = '---\napple-note-id: "ABC-123"\n---\n\n';

test('frontmatter splits exactly like icloud-md and rejoins byte for byte', () => {
  const text = `${FM}# Groceries\n\n- milk\n`;
  const { frontmatter, body } = splitFrontmatter(text);
  assert.equal(frontmatter, FM);
  assert.equal(body, '# Groceries\n\n- milk\n');
  assert.equal(frontmatter + body, text);
  // Greedy fold in-body, exactly one blank line in a filename vault.
  assert.equal(splitFrontmatter('---\na: 1\n---\n\n\nBody').body, 'Body');
  assert.equal(splitFrontmatter('---\na: 1\n---\n\n\nBody', true).body, '\nBody');
  // Not frontmatter: no closing fence, or a thematic break in a filename vault.
  assert.equal(splitFrontmatter('---\nno close').frontmatter, '');
  assert.equal(splitFrontmatter('---\n\ntext\n---\n', true).frontmatter, '');
});

test('titles and snippets read like the Notes list', () => {
  assert.equal(plainText('# **Big** _plan_ for <u>Q4</u>'), 'Big plan for Q4');
  assert.equal(plainText('- [ ] buy [milk](https://x.y)'), 'buy milk');
  assert.equal(plainText('Price is 5\\* cheaper'), 'Price is 5* cheaper');
  const d = describe('\n# Trip\n\n- [x] passport\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.equal(d.title, 'Trip');
  assert.equal(d.snippet, 'passport a b 1 2');
  assert.equal(describe('').title, 'New Note');
});

test('scan finds folders, counts, read-only notes, and skips hidden and attachment dirs', () => {
  const { root, v } = vault();
  fs.mkdirSync(path.join(root, 'Notes'));
  fs.mkdirSync(path.join(root, 'Recipes', 'Desserts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Recipes', 'attachments'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'Notes', 'A.md'), `${FM}# A\nhello\n`);
  fs.writeFileSync(path.join(root, 'Recipes', 'Cake.md'), '# Cake\n![photo](attachments/cake.jpg)\n');
  fs.writeFileSync(path.join(root, 'Recipes', 'Desserts', 'Pie.md'), '# Pie\n');
  fs.writeFileSync(path.join(root, '.git', 'x.md'), 'ignored');
  const s = v.scan();
  assert.deepEqual(
    s.folders.map((f) => [f.id, f.depth, f.count]),
    [['Notes', 0, 1], ['Recipes', 0, 1], ['Recipes/Desserts', 1, 1]],
  );
  const cake = s.notes.find((n) => n.title === 'Cake');
  assert.equal(cake.readOnly, true);
  assert.equal(s.notes.find((n) => n.title === 'A').noteId, 'ABC-123');
});

test('write keeps the frontmatter, create names the file after the title', () => {
  const { root, v } = vault();
  fs.mkdirSync(path.join(root, 'Notes'));
  fs.writeFileSync(path.join(root, 'Notes', 'A.md'), `${FM}# A\nold\n`);
  v.write('Notes/A.md', '# A renamed\nnew text\n');
  assert.equal(fs.readFileSync(path.join(root, 'Notes', 'A.md'), 'utf8'), `${FM}# A renamed\nnew text\n`);

  const made = v.create('Notes', '# Plans: 2027/Q1?\nbody\n');
  assert.equal(made.id, 'Notes/Plans- 2027-Q1-.md');
  assert.equal(made.title, 'Plans: 2027/Q1?');
  assert.equal(v.create('Notes', '# Plans: 2027/Q1?\n').id, 'Notes/Plans- 2027-Q1- 2.md');
});

test('filename vaults: the title line becomes the name, a retitle is an apple-note-title request', () => {
  const { root, v } = vault('filename');
  fs.writeFileSync(path.join(root, 'Shopping.md'), `---\napple-note-id: "N1"\n---\n\n- eggs\n`);
  assert.equal(v.scan().notes[0].title, 'Shopping');
  v.write('Shopping.md', '# Shopping list\n\n- eggs\n- milk\n');
  const text = fs.readFileSync(path.join(root, 'Shopping.md'), 'utf8');
  assert.match(text, /^apple-note-title: "Shopping list"$/m);
  assert.match(text, /apple-note-id: "N1"/);
  assert.ok(text.endsWith('\n- eggs\n- milk\n'));
  assert.ok(!text.includes('# Shopping list'));
  const made = v.create('', '# Ideas\n\nfirst\n');
  assert.equal(made.id, 'Ideas.md');
  assert.equal(fs.readFileSync(path.join(root, 'Ideas.md'), 'utf8'), 'first\n');
});

test('paths outside the vault are refused', () => {
  const { v } = vault();
  assert.throws(() => v.read('../etc/passwd.md'), /outside/);
  assert.throws(() => v.read('/etc/hosts.md'), /bad path/);
  assert.throws(() => v.write('notes.txt', 'x'), /not a note/);
  assert.equal(v.attachmentPath('Notes/A.md', '../../../etc/passwd'), null);
});

test('move and folders', () => {
  const { root, v } = vault();
  fs.writeFileSync(path.join(root, 'A.md'), '# A\n');
  const folder = v.createFolder('', 'Work');
  assert.equal(folder, 'Work');
  assert.throws(() => v.createFolder('', 'Work'), /already exists/);
  assert.throws(() => v.createFolder('', 'attachments'), /reserved/);
  assert.equal(v.move('A.md', 'Work'), 'Work/A.md');
  v.remove('Work/A.md');
  assert.equal(v.scan().notes.length, 0);
});
