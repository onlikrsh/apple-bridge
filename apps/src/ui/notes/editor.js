// The note editor: rich text on screen, Markdown on disk.
//
// The node set is exactly what icloud-md maps to Apple Notes formatting:
// Title/Heading/Subheading = # / ## / ###, Monostyled = fenced code,
// bulleted/numbered/check lists, block quotes, tables, links, and
// bold/italic/strikethrough plus underline as raw <u>. Markdown output uses
// `-` bullets and tight lists, matching icloud-md's own renderer, so saving
// an untouched paragraph doesn't rewrite it.

import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';

// tiptap-markdown only marks bullet and numbered lists as tight; without this
// a checklist is written back with blank lines between its items.
const TightTaskLists = Extension.create({
  name: 'tightTaskLists',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (el) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
            renderHTML: (attrs) => (attrs.tight ? { 'data-tight': 'true' } : {}),
          },
        },
      },
    ];
  },
});

/** The note as Markdown, ending in one newline like icloud-md's own files. */
export function noteMarkdown(editor) {
  const md = editor.storage.markdown.getMarkdown();
  return md.endsWith('\n') ? md : `${md}\n`;
}

export function createEditor(element, { onUpdate }) {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        horizontalRule: false,
        codeBlock: { HTMLAttributes: { class: 'mono' } },
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      TaskList,
      TightTaskLists,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false }),
      Placeholder.configure({
        placeholder: ({ node, pos }) => (pos === 0 && node.type.name === 'heading' ? 'Title' : ''),
        showOnlyCurrent: false,
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    editorProps: {
      attributes: { class: 'note-body', spellcheck: 'true' },
      handleClickOn(view, pos, node, nodePos, event) {
        // Ctrl+click opens links, like Cmd+click on a Mac.
        const a = event.target.closest && event.target.closest('a[href]');
        if (a && (event.ctrlKey || !view.editable)) {
          window.api.openExternal(a.href);
          return true;
        }
        return false;
      },
    },
    onUpdate: () => onUpdate(),
  });
}
