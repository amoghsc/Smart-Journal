import { Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import type { MarkType, Node as PMNode } from '@tiptap/pm/model'

/**
 * Text the AI wrote and you haven't touched since. Unlike the fading highlight (aiFresh), this is saved with
 * the note: a `<span data-ai>` around the words. Lines made entirely of it get a thin purple rule and a ✦ in the
 * margin, so you can see at a glance how much of a note is AI-written. Editing any of it — typing, deleting,
 * formatting — makes the whole piece yours: the mark comes off every part of it.
 */

/** Set on transactions that write AI text, so they don't count as your edits. */
export const AI_INSERT = 'aiInsert'

const aiTextKey = new PluginKey<DecorationSet>('aiText')

/** A rule for each line that is all AI text, ✦ at the start of each run, and ✦ on lines that are partly AI. */
function margins(doc: PMNode, type: MarkType): DecorationSet {
  const decos: Decoration[] = []
  let prevWhole: string | null = null   // id of the line before, if it was all AI text
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let total = 0, ai = 0, id: string | null = null
    node.forEach(child => {
      const size = child.isText ? child.text!.length : 1
      total += size
      const m = child.marks.find(x => x.type === type)
      if (m) { ai += size; id ??= m.attrs.id as string }
    })
    if (!ai) { prevWhole = null; return false }
    const whole = ai === total
    const first = !(whole && prevWhole === id)
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: (whole ? 'ai-block' : 'ai-part') + (first ? ' ai-first' : '') }))
    prevWhole = whole ? id : null
    return false
  })
  return DecorationSet.create(doc, decos)
}

export const AiText = Mark.create({
  name: 'aiText',
  // typing right after AI text is yours, not the AI's
  inclusive: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: el => el.getAttribute('data-ai'),
        renderHTML: attrs => (attrs.id ? { 'data-ai': attrs.id } : {}),
      },
    }
  },
  parseHTML() { return [{ tag: 'span[data-ai]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'ai-text' }), 0] },

  addProseMirrorPlugins() {
    const type = this.type
    return [new Plugin<DecorationSet>({
      key: aiTextKey,
      state: {
        init: (_, state) => margins(state.doc, type),
        apply: (tr, set) => (tr.docChanged ? margins(tr.doc, type) : set),
      },
      props: { decorations: state => aiTextKey.getState(state) },

      // an edit anywhere in a piece of AI text un-marks the whole piece (undo brings the mark back with the edit)
      appendTransaction(trs, _old, state) {
        const edited = new Set<string>()
        const collect = (doc: PMNode, from: number, to: number) => {
          if (to <= from) return
          doc.nodesBetween(from, to, n => { for (const m of n.marks) if (m.type === type && m.attrs.id) edited.add(m.attrs.id as string) })
        }
        for (const tr of trs) {
          // skip AI writes, undo/redo (history restores marks itself) and content loaded from elsewhere
          if (!tr.docChanged || tr.getMeta(AI_INSERT) || tr.getMeta('history$') || tr.getMeta('preventUpdate')) continue
          tr.steps.forEach((step, i) => {
            const before = tr.docs[i], after = tr.docs[i + 1] ?? tr.doc
            if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
              // a comment is a note about the text, not a change to it
              if (step.mark.type !== type && step.mark.type.name !== 'comment') collect(before, step.from, step.to)
              return
            }
            step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
              collect(before, oldStart, oldEnd)   // deleted or replaced AI text
              collect(after, newStart, newEnd)    // typed inside AI text (it carries the mark)
            })
          })
        }
        if (!edited.size) return null
        const tr = state.tr
        state.doc.descendants((n, pos) => {
          const m = n.marks.find(x => x.type === type && edited.has(x.attrs.id as string))
          if (m) tr.removeMark(pos, pos + n.nodeSize, m)
        })
        return tr.docChanged ? tr : null
      },
    })]
  },
})
