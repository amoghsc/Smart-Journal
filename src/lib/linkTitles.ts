import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { isBareLink, isJunkLinkText, linkLabel, linkMeta } from './linkMeta'
import type { LinkTitleStyle } from './settings'

/**
 * Link titles: a web address pasted or typed into a note turns into its page's title (and author, time, date — a
 * setting), looked up from the page itself, no AI. While it's looked up the link shimmers. It's filled in once:
 * only while the link still shows its bare address, so words you've written are never replaced; ⌘Z brings the
 * address back. Also used to (re)title links on request: the link hover's Refresh title and "Fix link titles".
 */

export interface LinkSpan { from: number; to: number; href: string; text: string }
interface Pending extends LinkSpan { id: number }
interface State { pending: Pending[]; fresh: boolean }
type Meta = { add: Pending[] } | { done: number[] }

export const linkTitlesKey = new PluginKey<State>('linkTitles')
let nextId = 1

/** The web links in [from, to] of `doc`, each as one span (a link's text may be split by bold, highlight…). */
export function linkSpans(doc: PMNode, from: number, to: number): LinkSpan[] {
  const out: LinkSpan[] = []
  const type = doc.type.schema.marks.link
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    let cur: LinkSpan | null = null
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      const href = child.isText ? (child.marks.find(m => m.type === type)?.attrs.href as string | undefined) : undefined
      if (href && cur && cur.href === href && cur.to === start) { cur.to = start + child.nodeSize; cur.text += child.text }
      else {
        if (cur) out.push(cur)
        cur = href ? { from: start, to: start + child.nodeSize, href, text: child.text! } : null
      }
    })
    if (cur) out.push(cur)
    return false
  })
  return out.filter(s => s.to > from && s.from < to)
}

/**
 * Look up the pages of `spans` and put their titles in, each only if its link still says what it said when asked
 * (`text`). Returns how many were filled in. One undo step per batch.
 */
export async function fillLinkTitles(view: EditorView, spans: LinkSpan[], style: LinkTitleStyle, refresh = false): Promise<number> {
  if (!spans.length || style === 'off') return 0
  const items = spans.map(s => ({ ...s, id: nextId++ }))
  view.dispatch(view.state.tr.setMeta(linkTitlesKey, { add: items } satisfies Meta).setMeta('addToHistory', false))
  const metas = await Promise.all(items.map(s => linkMeta(s.href, refresh)))
  if (view.isDestroyed) return 0
  const now = linkTitlesKey.getState(view.state)?.pending ?? []
  const tr = view.state.tr
  let filled = 0
  // from the end, so earlier positions stay put
  const jobs = items.map((s, i) => ({ s, meta: metas[i], at: now.find(p => p.id === s.id) })).filter(j => j.at).sort((a, b) => b.at!.from - a.at!.from)
  for (const { s, meta, at } of jobs) {
    const label = linkLabel(s.href, meta, style)
    if (!label || !at) continue
    const doc = tr.doc, { from, to } = at
    // still the same link, saying the same thing?
    if (doc.textBetween(from, to, '', '￼') !== s.text) continue
    const node = doc.nodeAt(from)
    if (!node?.marks.some(m => m.type.name === 'link' && m.attrs.href === s.href)) continue
    tr.replaceWith(from, to, doc.type.schema.text(label, node.marks))
    filled++
  }
  tr.setMeta(linkTitlesKey, { done: items.map(s => s.id) } satisfies Meta)
  // its own undo step: ⌘Z takes the title back to the address, not the paste away with it
  if (filled) closeHistory(tr); else tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  return filled
}

/** A transaction whose new links should be titled: typed or pasted, not undo/redo, loading or our own. */
function qualifies(tr: Transaction) {
  const root = (tr.getMeta('appendedTransaction') as Transaction | undefined) ?? tr
  return tr.docChanged && !root.getMeta('history$') && !root.getMeta('preventUpdate') && !root.getMeta(linkTitlesKey) && root.getMeta('uiEvent') !== 'drop'
}

export const LinkTitles = Extension.create<{ style: () => LinkTitleStyle }>({
  name: 'linkTitles',
  addOptions() { return { style: () => 'full' as LinkTitleStyle } },

  addProseMirrorPlugins() {
    const style = this.options.style
    return [new Plugin<State>({
      key: linkTitlesKey,
      state: {
        init: () => ({ pending: [], fresh: false }),
        apply(tr, cur) {
          const meta = tr.getMeta(linkTitlesKey) as Meta | undefined
          let pending = cur.pending
          if (tr.docChanged) pending = pending.map(p => ({ ...p, from: tr.mapping.map(p.from, 1), to: tr.mapping.map(p.to, -1) })).filter(p => p.to > p.from)
          if (meta && 'add' in meta) pending = [...pending, ...meta.add]
          if (meta && 'done' in meta) pending = pending.filter(p => !meta.done.includes(p.id))
          // appended transactions (e.g. the link mark added as you type a space after an address) belong to their root
          const fresh = tr.getMeta('appendedTransaction') ? cur.fresh || qualifies(tr) : qualifies(tr)
          return pending === cur.pending && fresh === cur.fresh ? cur : { pending, fresh }
        },
      },
      props: {
        decorations(state: EditorState) {
          const p = linkTitlesKey.getState(state)?.pending
          return p?.length ? DecorationSet.create(state.doc, p.map(x => Decoration.inline(x.from, x.to, { class: 'link-loading' }))) : null
        },
      },
      view: () => ({
        update(view, prev) {
          if (view.state.doc === prev.doc || !linkTitlesKey.getState(view.state)?.fresh || style() === 'off') return
          // only what changed: new links there that show their bare address
          const start = prev.doc.content.findDiffStart(view.state.doc.content)
          const end = prev.doc.content.findDiffEnd(view.state.doc.content)
          if (start == null || !end) return
          const doc = view.state.doc
          const from = Math.max(0, Math.min(start, end.b) - 1), to = Math.min(doc.content.size, Math.max(start, end.b) + 1)
          const pending = linkTitlesKey.getState(view.state)!.pending
          const bare = linkSpans(doc, from, to).filter(s => isBareLink(s.text, s.href) && !pending.some(p => p.from === s.from))
          // not the one being typed: an address gets its title once it's finished (a space, Enter or paste)
          if (bare.length) queueMicrotask(() => { if (!view.isDestroyed) fillLinkTitles(view, bare, style()) })
        },
      }),
    })]
  },
})

/**
 * "Fix link titles" on a selection: clear leftovers like <!----> and the [ ] around a link, then title every link
 * whose words aren't a title (junk, a timestamp, its bare address). Returns how many links were titled.
 */
export async function fixLinksIn(view: EditorView, from: number, to: number, style: LinkTitleStyle): Promise<number> {
  const tr = view.state.tr
  const cuts: [number, number][] = []
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    for (const m of node.text!.matchAll(/<!--[\s\S]*?-->/g)) cuts.push([pos + m.index!, pos + m.index! + m[0].length])
    return false
  })
  const doc = view.state.doc
  for (const s of linkSpans(doc, from, to)) {
    if (!isJunkLinkText(s.text, s.href)) continue
    if (s.from > 0 && s.to < doc.content.size && doc.textBetween(s.from - 1, s.from) === '[' && doc.textBetween(s.to, s.to + 1) === ']') cuts.push([s.from - 1, s.from], [s.to, s.to + 1])
  }
  cuts.sort((a, b) => b[0] - a[0]).forEach(([a, b]) => tr.delete(a, b))
  let a = from, b = to
  if (tr.docChanged) { a = tr.mapping.map(from, -1); b = tr.mapping.map(to, 1); view.dispatch(tr) }
  const junk = linkSpans(view.state.doc, a, b).filter(s => isJunkLinkText(s.text, s.href))
  return fillLinkTitles(view, junk, style === 'off' ? 'full' : style)
}
