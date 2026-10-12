'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/ui/notes/merge.js');

// The shape that froze the iPhone: icloud-md's rendering of a note with two
// empty paragraphs, a table and a checklist, and how the editor writes it back.
const ORIGINAL = '# Shop\n\n\n\n| Aisle | |\n| - | - |\n| | |\n- [ ] Milk\n';
const BASELINE = '# Shop\n\n| Aisle |  |\n| --- | --- |\n|  |  |\n\n- [ ] Milk\n';

test('ticking a box changes that line and nothing else', async () => {
  const { mergeEdit } = await load();
  const edited = BASELINE.replace('- [ ] Milk', '- [x] Milk');
  assert.equal(mergeEdit(ORIGINAL, BASELINE, edited), ORIGINAL.replace('- [ ] Milk', '- [x] Milk'));
});

test('an edit keeps trailing spaces and blank-line runs elsewhere', async () => {
  const { mergeEdit } = await load();
  const original = '# Plan  \nPack bags \n\n\nBuy tickets\nCall Ada \n';
  const baseline = '# Plan\n\nPack bags\n\nBuy tickets\nCall Ada\n';
  const edited = '# Plan\n\nPack bags\n\nBuy train tickets\nCall Ada\n';
  assert.equal(mergeEdit(original, baseline, edited), '# Plan  \nPack bags \n\n\nBuy train tickets\nCall Ada \n');
});

test('where the edit touches normalised lines, the edited lines win', async () => {
  const { mergeEdit } = await load();
  const original = 'Title\nline one \nline two\n';
  const baseline = 'Title\n\nline one\nline two\n';
  const edited = 'Title\n\nline 1\nline two\n';
  // "line one " was normalised and edited: the edit wins there; the blank
  // line the editor added is still taken out.
  assert.equal(mergeEdit(original, baseline, edited), 'Title\nline 1\nline two\n');
});

test('adding a line at the end, and deleting one in the middle', async () => {
  const { mergeEdit } = await load();
  assert.equal(mergeEdit(ORIGINAL, BASELINE, `${BASELINE}- [ ] Eggs\n`), `${ORIGINAL}- [ ] Eggs\n`);
  const original = 'A \nB \nC \n';
  const baseline = 'A\nB\nC\n';
  assert.equal(mergeEdit(original, baseline, 'A\nC\n'), 'A \nC \n');
});

test('nothing edited gives the file back; a new note is the edit as is', async () => {
  const { mergeEdit } = await load();
  assert.equal(mergeEdit(ORIGINAL, BASELINE, BASELINE), ORIGINAL);
  assert.equal(mergeEdit(null, '', '# New\n'), '# New\n');
  assert.equal(mergeEdit('same\n', 'same\n', 'changed\n'), 'changed\n');
});

test('diffLines hunks always rebuild the target', async () => {
  const { diffLines } = await load();
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words = ['', 'a', 'b', 'c', '- [ ] x', '| t |'];
  for (let round = 0; round < 500; round += 1) {
    const a = Array.from({ length: rand(9) }, () => words[rand(words.length)]);
    const b = Array.from({ length: rand(9) }, () => words[rand(words.length)]);
    const out = [];
    let at = 0;
    for (const h of diffLines(a, b)) {
      assert.ok(h.start >= at && h.end >= h.start, 'hunks are sorted and disjoint');
      out.push(...a.slice(at, h.start), ...h.lines);
      at = h.end;
    }
    out.push(...a.slice(at));
    assert.deepEqual(out, b, JSON.stringify({ a, b }));
  }
});
