import { Mark, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * A comment is a mark on the commented text: `<span data-comment-id="…" data-comment="…">`.
 * The comment body lives in the attribute, so comments travel with the note's HTML.
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (id: string) => ReturnType
      updateComment: (id: string, text: string) => ReturnType
      removeComment: (id: string) => ReturnType
    }
  }
}

export interface CommentInfo { id: string; text: string; from: number; to: number }

export const Comment = Mark.create({
  name: 'comment',
  inclusive: false,

  addAttributes() {
    return {
      id: { default: null, parseHTML: el => el.getAttribute('data-comment-id'), renderHTML: a => ({ 'data-comment-id': a.id }) },
      text: { default: '', parseHTML: el => el.getAttribute('data-comment') ?? '', renderHTML: a => ({ 'data-comment': a.text }) },
    }
  },
  parseHTML() { return [{ tag: 'span[data-comment-id]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes({ class: 'comment' }, HTMLAttributes), 0] },

  addCommands() {
    return {
      setComment: id => ({ commands }) => commands.setMark(this.name, { id, text: '' }),
      updateComment: (id, text) => ({ tr, state }) => {
        let did = false
        state.doc.descendants((node, pos) => {
          const m = node.marks.find(x => x.type.name === this.name && x.attrs.id === id)
          if (m) { tr.addMark(pos, pos + node.nodeSize, m.type.create({ ...m.attrs, text })); did = true }
        })
        return did
      },
      removeComment: id => ({ tr, state }) => {
        let did = false
        state.doc.descendants((node, pos) => {
          const m = node.marks.find(x => x.type.name === this.name && x.attrs.id === id)
          if (m) { tr.removeMark(pos, pos + node.nodeSize, m); did = true }
        })
        return did
      },
    }
  },
})

/** Every comment in the document, in text order, with the span it covers. */
export function listComments(doc: PMNode): CommentInfo[] {
  const map = new Map<string, CommentInfo>()
  doc.descendants((node, pos) => {
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue
      const c = map.get(m.attrs.id)
      if (c) c.to = pos + node.nodeSize
      else map.set(m.attrs.id, { id: m.attrs.id, text: m.attrs.text ?? '', from: pos, to: pos + node.nodeSize })
    }
  })
  return [...map.values()].sort((a, b) => a.from - b.from)
}
