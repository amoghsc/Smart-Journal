import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Find in this note: every match of the query is highlighted (case doesn't matter), the current one more strongly.
 * Matches are found line by line, so they may cross bold, links and other formatting within a line.
 */

export interface Hit { from: number; to: number }
interface SearchState { query: string; hits: Hit[]; current: number }
type Meta = { query: string } | { current: number }

export const noteSearchKey = new PluginKey<SearchState>('noteSearch')

function find(doc: PMNode, query: string): Hit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: Hit[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // one character per position: text as is, anything else inline (a note link, a line break) as a stand-in
    let text = ''
    node.forEach(child => { text += child.isText ? child.text! : '￼'.repeat(child.nodeSize) })
    const lower = text.toLowerCase()
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) hits.push({ from: pos + 1 + i, to: pos + 1 + i + q.length })
    return false
  })
  return hits
}

/** Search this note for `query` ('' clears it). */
export function setNoteSearch(view: EditorView, query: string) {
  view.dispatch(view.state.tr.setMeta(noteSearchKey, { query } satisfies Meta).setMeta('addToHistory', false))
}
/** Make match `i` the current one. */
export function setNoteSearchCurrent(view: EditorView, current: number) {
  view.dispatch(view.state.tr.setMeta(noteSearchKey, { current } satisfies Meta).setMeta('addToHistory', false))
}

export const NoteSearch = Extension.create({
  name: 'noteSearch',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: noteSearchKey,
      state: {
        init: () => ({ query: '', hits: [], current: -1 }),
        apply(tr, cur) {
          const meta = tr.getMeta(noteSearchKey) as Meta | undefined
          if (meta && 'current' in meta) return { ...cur, current: meta.current }
          if (meta && 'query' in meta) { const hits = find(tr.doc, meta.query); return { query: meta.query, hits, current: hits.length ? 0 : -1 } }
          if (!tr.docChanged || !cur.query) return cur
          const hits = find(tr.doc, cur.query)
          return { ...cur, hits, current: hits.length ? Math.min(Math.max(cur.current, 0), hits.length - 1) : -1 }
        },
      },
      props: {
        decorations(state) {
          const s = noteSearchKey.getState(state)
          if (!s?.hits.length) return null
          return DecorationSet.create(state.doc, s.hits.map((h, i) =>
            Decoration.inline(h.from, h.to, { class: i === s.current ? 'search-hit current' : 'search-hit', 'data-hit': String(i) })))
        },
      },
    })]
  },
})
