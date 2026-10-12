// Edit a Reminders title or notes document as the CRDT it is.
//
// TitleDocument and NotesDocument hold a versioned_document.Document whose
// version is a topotext.String: the same mergeable-string format Notes uses
// for note bodies, with every character's id, deletions kept as tombstones
// and a clock per replica. pyicloud writes a brand-new document on every
// update, under one fixed replica id with clocks restarting at 0, so a second
// edit reuses ids that already name other characters on the iPhone. This
// edits the existing document instead, under our own replica, with
// icloud-md's editor (checked against Apple's own client; 732 real reminder
// documents round-trip through it byte for byte).
//
//   node abridge-topotext.mjs <icloud-md package dir>
//   stdin:  {"doc": base64 of the decompressed document, or null, "text": "...", "replica": base64 16 bytes}
//   stdout: {"doc": base64 of the new document}
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const pkg = process.argv[2];
if (!pkg) fail('usage: abridge-topotext.mjs <icloud-md package dir>');
let nd;
try {
  nd = await import(pathToFileURL(path.join(pkg, 'dist/notes/noteDocument.js')).href);
} catch (err) {
  fail(`cannot load icloud-md from ${pkg}: ${err.message}`);
}

const { doc, text, replica } = JSON.parse(readFileSync(0, 'utf8'));
const replicaId = new Uint8Array(Buffer.from(replica, 'base64'));
if (replicaId.length !== 16) fail('the replica id must be 16 bytes');

let document;
if (doc == null) {
  // Shaped exactly like the iPhone's first save of a typed title.
  document = nd.buildInitialNoteDocument(text, replicaId);
} else {
  const raw = new Uint8Array(Buffer.from(doc, 'base64'));
  if (!nd.noteDocumentRoundTrips(raw)) fail("this reminder's text uses a document layout abridge can't edit safely");
  document = nd.parseNoteDocument(raw);
  nd.applyTextEdit(document, text, { replicaId });
}
nd.validateDocumentInvariants(document);
const bytes = nd.encodeNoteDocument(document);
if (!nd.noteDocumentRoundTrips(bytes) || nd.parseNoteDocument(bytes).text !== text) {
  fail('the edited document failed verification');
}
process.stdout.write(`${JSON.stringify({ doc: Buffer.from(bytes).toString('base64') })}\n`);
