// icloud-md's Markdown is line-oriented: every Apple Notes paragraph is one
// line, an empty paragraph is an empty line, and consecutive plain lines are
// separate paragraphs (icloud-md's parser splits soft breaks and lazy
// continuations back into lines). The editor reads Markdown by CommonMark,
// which would join `a⏎b⏎c` into one paragraph, drop empty lines and fold a
// line after a list into its last item. So notes cross into the editor and
// back through these two functions:
//
//   toEditor:  each line becomes its own block (lists, tables and fenced code
//              stay together), each empty line an explicit empty paragraph.
//   noteLines: each top-level block back to its own line(s), joined by single
//              newlines, empty paragraphs as empty lines.

const LIST = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const TABLE = /^\s*\|/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const EMPTY = '<p></p>'; // read as an empty paragraph (html: true)

/** icloud-md's Markdown as Markdown the editor reads into the same paragraphs. */
export function toEditor(md) {
  if (md === '') return '';
  const lines = (md.endsWith('\n') ? md.slice(0, -1) : md).split('\n');
  const blocks = [];
  let i = 0;
  const take = (end) => {
    blocks.push(lines.slice(i, end).join('\n'));
    i = end;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !lines[end].trim().startsWith(fence[1])) end += 1;
      take(Math.min(end + 1, lines.length));
    } else if (TABLE.test(line) || LIST.test(line)) {
      const kind = TABLE.test(line) ? TABLE : LIST;
      let end = i + 1;
      while (end < lines.length && kind.test(lines[end])) end += 1;
      take(end);
    } else {
      blocks.push(line.trim() === '' ? EMPTY : line);
      i += 1;
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/** The editor's document as icloud-md's Markdown. */
export function noteLines(editor) {
  const serializer = editor.storage.markdown.serializer;
  const doc = editor.schema.topNodeType;
  const lines = [];
  const block = (node, prefix = '') => {
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      lines.push(prefix.trimEnd());
    } else if (node.type.name === 'blockquote') {
      node.forEach((child) => block(child, `${prefix}> `));
    } else {
      const md = serializer.serialize(doc.create(null, [node])).replace(/\n+$/, '');
      // A hard break (Shift+Enter) ends a paragraph, as on the iPhone: its
      // `\` marker goes and the rest is a line of its own.
      const out = md.split('\n').map((l, at, all) => (at < all.length - 1 ? l.replace(/(?<!\\)\\$/, '') : l));
      for (const l of out) lines.push(`${prefix}${l}`);
    }
  };
  editor.state.doc.forEach((node) => block(node));
  return `${lines.join('\n')}\n`;
}
