// Edits from Linux that icloud-md must turn into well-formed note documents,
// for tests/test_icloud_md_patch.py. Each scenario starts from a note written
// by another replica (standing in for the iPhone), applies one Markdown edit
// the way `icloud-md push` does, and prints one JSON line: the paragraphs
// left with mixed paragraph styles, and whether icloud-md's own verification
// accepted the result. Then a few direct checks of the patch's detector.
//
//   node icloud_md_scenarios.mjs <dist to edit with> [<dist to detect with>]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [editDist, detectDist = editDist] = process.argv.slice(2);
const load = (dist, p) => import(pathToFileURL(path.join(dist, p)).href);
const nd = await load(editDist, 'notes/noteDocument.js');
const { reconcileNoteFormat } = await load(editDist, 'notes/formatReconcile.js');
const { decodeNoteFormat, formatsRoundTripEqual } = await load(editDist, 'notes/noteFormat.js');
const { parseNoteMarkdown } = await load(editDist, 'notes/parseNoteMarkdown.js');
const { compressNoteDocument, decodeNoteString } = await load(editDist, 'notes/noteText.js');
const { ParagraphStyleSchema, AttributeRunSchema } = await load(editDist, 'notes/gen/topotext_pb.js');
const { create } = await import(pathToFileURL(path.join(editDist, '../node_modules/@bufbuild/protobuf/dist/esm/index.js')).href);
const { mixedParagraphStyles } = await load(detectDist, 'notes/formatReconcile.js');

const IPHONE = new Uint8Array(16).fill(0x11);
const LINUX = new Uint8Array(16).fill(0x22);

// Independent of the patch: compares every paragraph-style field's effective
// value (unset reads as default) across a paragraph's characters.
function mixed(doc) {
  const key = (ps) => {
    const message = ps ?? create(ParagraphStyleSchema);
    return JSON.stringify(ParagraphStyleSchema.fields.map((f) => {
      const v = message[f.localName];
      if (f.fieldKind === 'message') return v ? `${Buffer.from(v.todoUUID ?? []).toString('hex')}:${v.done}` : null;
      return v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v;
    }));
  };
  const keyAt = [];
  for (const run of doc.attributeRuns) for (let i = 0; i < run.length; i += 1) keyAt.push(key(run.paragraphStyle));
  const out = [];
  let start = 0;
  const lines = doc.text.split('\n');
  lines.forEach((line, i) => {
    const end = start + line.length + (i < lines.length - 1 ? 1 : 0);
    if (new Set(keyAt.slice(start, end)).size > 1) out.push(i);
    start = end;
  });
  return out;
}

function parsed(markdown) {
  const p = parseNoteMarkdown(markdown);
  if (p.status !== 'ok') throw new Error(`markdown did not parse: ${p.reason}`);
  return p;
}

function edit(doc, desired, replica) {
  nd.applyTextEdit(doc, desired.text, { replicaId: replica });
  const r = reconcileNoteFormat(doc, desired.paragraphs, replica);
  if (!r.ok) throw new Error(r.reason);
  nd.validateDocumentInvariants(doc);
}

function verified(doc, desired) {
  const s = decodeNoteString(compressNoteDocument(nd.encodeNoteDocument(doc)));
  const f = decodeNoteFormat(s.string, s.attributeRun);
  return s.string === desired.text && f.status === 'ok' && formatsRoundTripEqual(f.paragraphs, desired.paragraphs);
}

const scenarios = {
  // Inserted text inherits the previous paragraph's run while the newline
  // keeps the item's checklist style: unpatched, the paragraph is mixed.
  'type at the start of a checklist item': ['# Shop\nNotes here\n- [ ] Milk\n', '# Shop\nNotes here\n- [ ] Oat Milk\n'],
  'type at the start of a heading after a list': ['# Plan\n- [ ] Pack\n## Day one\n', '# Plan\n- [ ] Pack\n## The day one\n'],
  'tick a checkbox': ['# Shop\n- [ ] Milk\n- [ ] Eggs\n', '# Shop\n- [x] Milk\n- [ ] Eggs\n'],
  'add a checklist item between two': ['# Shop\n- [ ] Milk\n- [ ] Eggs\n', '# Shop\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs\n'],
  'turn a body line into a checklist item': ['# Shop\nMilk\n', '# Shop\n- [ ] Milk\n'],
  'delete the line between two paragraphs': ['# Notes\nFirst\nGone\n- [ ] Third\n', '# Notes\nFirst\n- [ ] Third\n'],
};

for (const [name, [before, after]] of Object.entries(scenarios)) {
  const original = parsed(before);
  const doc = nd.buildInitialNoteDocument(original.text, IPHONE);
  edit(doc, original, IPHONE);
  const startMixed = mixed(doc);
  const desired = parsed(after);
  edit(doc, desired, LINUX);
  console.log(JSON.stringify({
    kind: 'scenario', name, startMixed, mixed: mixed(doc), detected: mixedParagraphStyles(doc.text, doc.attributeRuns), verified: verified(doc, desired),
  }));
}

// The detector on hand-made runs: one paragraph "ab\n" in two runs.
const run = (length, style) => create(AttributeRunSchema, { length, paragraphStyle: create(ParagraphStyleSchema, style) });
const detect = (styles) => mixedParagraphStyles('ab\n', [run(1, styles[0]), run(2, styles[1])]);
console.log(JSON.stringify({ kind: 'detector', name: 'same style', detected: detect([{ style: 100 }, { style: 100 }]) }));
// Apple's own notes do this: an explicit zero next to an unset field.
console.log(JSON.stringify({ kind: 'detector', name: 'explicit vs implicit zero', detected: detect([{ style: 100 }, { style: 100, alignment: 0 }]) }));
console.log(JSON.stringify({ kind: 'detector', name: 'body vs checklist', detected: detect([{ style: 3 }, { style: 103 }]) }));
