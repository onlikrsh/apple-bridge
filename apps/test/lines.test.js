'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/ui/notes/lines.js');

test('every line becomes its own block; empty lines are empty paragraphs', async () => {
  const { toEditor } = await load();
  // icloud-md's rendering: one Apple paragraph per line.
  assert.equal(toEditor('# Rent\n\nOrder 1\nOrder 2\n'), '# Rent\n\n<p></p>\n\nOrder 1\n\nOrder 2\n');
});

test('lists, tables and fenced code stay together; a line after them stands alone', async () => {
  const { toEditor } = await load();
  assert.equal(toEditor('- a\n  - b\n- [ ] c\nAfter\n'), '- a\n  - b\n- [ ] c\n\nAfter\n');
  assert.equal(toEditor('| A | B |\n| - | - |\n| 1 | |\n- [ ] M\n'), '| A | B |\n| - | - |\n| 1 | |\n\n- [ ] M\n');
  assert.equal(toEditor('```\nx\n\ny\n```\nz\n'), '```\nx\n\ny\n```\n\nz\n');
  assert.equal(toEditor('> one\n> two\n'), '> one\n\n> two\n');
});

test('the last line needs no newline; an empty note stays empty', async () => {
  const { toEditor } = await load();
  assert.equal(toEditor('a\nb'), 'a\n\nb\n');
  assert.equal(toEditor(''), '');
});
