import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Slice } from '@tiptap/pm/model'

/**
 * Text the AI just wrote gets a purple highlight that fades out over 20 seconds. The highlight is a
 * decoration, not part of the note: it is never saved, published or copied. Each highlight remembers
 * the text it replaced, so "Undo" can put exactly that back even after other edits.
 */

/** How long the highlight takes to fade (keep in step with the .ai-fresh animation in index.css). */
export const AI_FRESH_MS = 20_000

export interface FreshEntry {
  id: string
  from: number
  to: number
  /** What the AI replaced; null when the AI only added text (undo then just removes it). */
  original: Slice | null
  at: number
}

type Meta = { add: FreshEntry } | { remove: string } | { expire: true }

export const aiFreshKey = new PluginKey<FreshEntry[]>('aiFresh')
// prosemirror-history tags undo/redo transactions under this key. It has to be the string: a second
// `new PluginKey('history')` would get a different, auto-numbered key and never match.
const HISTORY_META = 'history$'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiFresh: {
      /** Undo one AI change: restore what it replaced (or remove what it added). */
      revertAiFresh: (id: string) => ReturnType
    }
  }
}

/** Mark [from, to] of `tr` as freshly written by the AI. Call on the same transaction that inserted it. */
export function markAiFresh(tr: Transaction, from: number, to: number, original: Slice | null) {
  if (to <= from) return tr
  return tr.setMeta(aiFreshKey, { add: { id: crypto.randomUUID(), from, to, original, at: Date.now() } } satisfies Meta)
}

// ---- choosing between AI versions ------------------------------------------------------------------
// While you compare, the note itself is untouched: the options live in a widget between paragraphs and the
// text they would replace is only outlined. Positions follow edits made meanwhile.

export interface CompareState {
  /** Where the options panel sits: between top-level blocks. */
  at: number
  /** The text the chosen option replaces (from === to when it will be added instead). */
  from: number
  to: number
  dom: HTMLElement
}
type CompareMeta = { show: CompareState } | { clear: true }
export const aiCompareKey = new PluginKey<CompareState | null>('aiCompare')

export function showCompare(tr: Transaction, state: CompareState) { return tr.setMeta(aiCompareKey, { show: state } satisfies CompareMeta).setMeta('addToHistory', false) }
export function clearCompare(tr: Transaction) { return tr.setMeta(aiCompareKey, { clear: true } satisfies CompareMeta).setMeta('addToHistory', false) }

const comparePlugin = () => new Plugin<CompareState | null>({
  key: aiCompareKey,
  state: {
    init: () => null,
    apply(tr, cur) {
      const meta = tr.getMeta(aiCompareKey) as CompareMeta | undefined
      if (meta && 'show' in meta) return meta.show
      if (meta && 'clear' in meta) return null
      if (!cur || !tr.docChanged) return cur
      const from = tr.mapping.map(cur.from, 1), to = Math.max(from, tr.mapping.map(cur.to, -1))
      return { ...cur, at: tr.mapping.map(cur.at, 1), from, to }
    },
  },
  props: {
    decorations(state) {
      const c = aiCompareKey.getState(state)
      if (!c) return null
      const decos = [Decoration.widget(c.at, c.dom, { side: 1, key: 'ai-compare', stopEvent: () => true, ignoreSelection: true })]
      if (c.to > c.from) decos.push(Decoration.inline(c.from, c.to, { class: 'ai-source' }))
      return DecorationSet.create(state.doc, decos)
    },
  },
})

export const AiFresh = Extension.create<object, { timer: ReturnType<typeof setInterval> | null }>({
  name: 'aiFresh',

  addStorage() { return { timer: null } },

  addCommands() {
    return {
      revertAiFresh: id => ({ state, tr, dispatch }) => {
        const e = aiFreshKey.getState(state)?.find(x => x.id === id)
        if (!e) return false
        if (dispatch) {
          tr.replace(e.from, e.to, e.original ?? Slice.empty)
          tr.setMeta(aiFreshKey, { remove: id } satisfies Meta)
        }
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [comparePlugin(), new Plugin<FreshEntry[]>({
      key: aiFreshKey,
      state: {
        init: () => [],
        apply(tr, entries) {
          const meta = tr.getMeta(aiFreshKey) as Meta | undefined
          // ⌘Z / redo: the history plugin puts text back itself, so drop the highlights
          if (tr.getMeta(HISTORY_META)) return []
          let next = entries
          if (tr.docChanged) {
            next = next
              .map(e => ({ ...e, from: tr.mapping.map(e.from, 1), to: tr.mapping.map(e.to, -1) }))
              .filter(e => e.to > e.from)
          }
          if (meta && 'add' in meta) next = [...next, meta.add]
          if (meta && 'remove' in meta) next = next.filter(e => e.id !== meta.remove)
          if (meta && 'expire' in meta) { const now = Date.now(); next = next.filter(e => now - e.at < AI_FRESH_MS) }
          return next
        },
      },
      props: {
        decorations(state) {
          const entries = aiFreshKey.getState(state)
          if (!entries?.length) return null
          const now = Date.now()
          return DecorationSet.create(state.doc, entries.map(e => Decoration.inline(e.from, e.to, {
            class: 'ai-fresh',
            'data-ai-fresh': e.id,
            // start the fade part-way through if this decoration is redrawn later
            style: `animation-delay:-${Math.min(AI_FRESH_MS, now - e.at) / 1000}s`,
          })))
        },
      },
    })]
  },

  onCreate() {
    this.storage.timer = setInterval(() => {
      const entries = aiFreshKey.getState(this.editor.state)
      if (!entries?.length || this.editor.isDestroyed) return
      if (entries.some(e => Date.now() - e.at >= AI_FRESH_MS)) {
        this.editor.view.dispatch(this.editor.state.tr.setMeta(aiFreshKey, { expire: true } satisfies Meta).setMeta('addToHistory', false))
      }
    }, 5_000)
  },

  onDestroy() {
    if (this.storage.timer) clearInterval(this.storage.timer)
  },
})
