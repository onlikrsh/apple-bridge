// Saving a note without rewriting what wasn't edited.
//
// The editor reads Markdown into a document and writes it back in its own
// way: runs of blank lines (empty paragraphs in Notes) collapse, table cells
// are re-padded, trailing spaces go. Saving that would upload every one of
// those as an edit. In one real note it moved the blank lines around a table
// when only a checkbox was ticked, and icloud-md turned that into a
// paragraph that froze Notes on the iPhone. So a save keeps the file as it
// was and applies only what the user changed:
//
//   original --(the editor's normalisation)--> baseline --(the user's edit)--> edited
//
// Both steps are line diffs against `baseline`. The user's hunks are applied
// as they are; the normalisation is undone everywhere it doesn't touch them
// (where it does, the edited lines win). The caller checks that the result
// reads back as `edited` before writing it.

/** Line hunks turning `a` into `b`: [{ start, end, lines }], where a's lines
 * [start, end) become `lines`. Sorted and disjoint. */
export function diffLines(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    return [{ start: head, end: head + n, lines: b.slice(head, head + m) }];
  }
  // Longest common subsequence of the middle, then walk it into hunks.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[head + i] === b[head + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const hunks = [];
  let open = null;
  const flush = () => {
    if (open) hunks.push(open);
    open = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (!open) open = { start: head + i, end: head + i, lines: [] };
    if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      open.lines.push(b[head + j]);
      j += 1;
    } else {
      i += 1;
      open.end = head + i;
    }
  }
  flush();
  return hunks;
}

/** A line as the editor would write it, near enough to pair the two up:
 * no trailing spaces, table cells unpadded and every separator `-`. */
function loose(line) {
  const t = line.trimEnd();
  if (!t.trimStart().startsWith('|')) return t;
  return t
    .trim()
    .split('|')
    .map((cell) => cell.trim())
    .map((cell) => (/^:?-+:?$/.test(cell) ? '-' : cell))
    .join('|');
}

/** One normalisation hunk cut into the smallest pieces: lines that are the
 * same but for the editor's formatting pair up one to one, so an edit to one
 * of them leaves the others' original form alone. */
function refine(h, base) {
  const b = base.slice(h.start, h.end);
  const o = h.lines;
  const out = [];
  let bi = 0;
  let oi = 0;
  const pairs = (bEnd) => {
    for (; bi < bEnd; bi += 1, oi += 1) {
      if (b[bi] !== o[oi]) out.push({ start: h.start + bi, end: h.start + bi + 1, lines: [o[oi]] });
    }
  };
  for (const k of diffLines(b.map(loose), o.map(loose))) {
    pairs(k.start);
    out.push({ start: h.start + k.start, end: h.start + k.end, lines: o.slice(oi, oi + k.lines.length) });
    bi = k.end;
    oi += k.lines.length;
  }
  pairs(b.length);
  return out;
}

function overlaps(x, y) {
  if (x.start === x.end && y.start === y.end) return x.start === y.start; // two insertions at one place
  return x.start < y.end && y.start < x.end;
}

/** `edited` with every line it shares with `baseline` taken from `original`
 * instead, as far as the diffs allow. */
export function mergeEdit(original, baseline, edited) {
  if (original == null) return edited; // a new note
  if (edited === baseline) return original; // nothing edited
  if (original === baseline) return edited; // nothing to undo
  const base = baseline.split('\n');
  const edits = diffLines(base, edited.split('\n'));
  const undo = diffLines(base, original.split('\n'))
    .flatMap((h) => refine(h, base))
    .filter((h) => !edits.some((e) => overlaps(h, e)));
  // At one position an insertion goes before a replacement.
  const hunks = [...edits, ...undo].sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  const out = [];
  let at = 0;
  for (const h of hunks) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at));
  return out.join('\n');
}
