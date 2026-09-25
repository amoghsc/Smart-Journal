import { DOMParser as PMDOMParser, DOMSerializer, Fragment, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model'
import { selectionToText, textToContent } from './ai'

/**
 * Where an AI result goes, so it lands at the same level as the text it came from: in place of the selection,
 * or just below it. In a list, whole items are replaced by items at the same depth, and "adds below" becomes a
 * new item at that depth (its label, with the result nested under it) — never a paragraph after the whole list.
 */
export interface AiPlan {
  /** replace: [from, to] is replaced. after: from === to, where the result is added. */
  from: number
  to: number
  /** Where the versions show while you choose: just below the selected line, at its indent. */
  at: number
  /** inline: in the text's place (words or blocks); blocks: paragraphs after a block; items: list items. */
  kind: 'inline' | 'blocks' | 'items'
  /** What the model is sent. */
  text: string
}

const isList = (n: PMNode) => n.type.name === 'bulletList' || n.type.name === 'orderedList'

/** Just after the line `$pos` is in (inside its list item, if any). */
const lineEnd = ($pos: ResolvedPos) => ($pos.depth === 0 ? $pos.pos : $pos.after($pos.parent.isTextblock ? $pos.depth : 1))

/** Depth of the innermost list item around `$pos`, or -1. */
function itemDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'listItem') return d
  return -1
}

export function planAi(doc: PMNode, from: number, to: number, mode: 'replace' | 'after'): AiPlan {
  const $from = doc.resolve(from), $to = doc.resolve(to)
  const at = lineEnd($to)
  const oneLine = $from.sameParent($to) && $from.parent.isTextblock

  if (oneLine) {
    // words within one line: sent without their list marker, so they come back as words, not a list
    const text = selectionToText(doc, from, to).replace(/^\s*(?:-|\d+\.)\s+/, '')
    if (mode === 'replace') return { from, to, at, kind: 'inline', text }
    const li = itemDepth($to)
    if (li > 0) { const p = $to.after(li); return { from: p, to: p, at, kind: 'items', text } }
    return { from: at, to: at, at, kind: 'blocks', text }
  }

  // across lines: if they share a list, work in whole items of that list
  const shared = $from.sharedDepth(to)
  const node = $from.node(shared)
  const listDepth = isList(node) ? shared : node.type.name === 'listItem' ? shared - 1 : -1
  if (listDepth >= 0) {
    const itemFrom = $from.before(listDepth + 1), itemTo = $to.after(listDepth + 1)
    const text = selectionToText(doc, itemFrom, itemTo)
    return mode === 'replace'
      ? { from: itemFrom, to: itemTo, at, kind: 'items', text }
      : { from: itemTo, to: itemTo, at, kind: 'items', text }
  }

  const text = selectionToText(doc, from, to)
  const below = shared + 1 <= $to.depth ? $to.after(shared + 1) : to
  return mode === 'replace'
    ? { from, to, at: below, kind: 'inline', text }
    : { from: below, to: below, at: below, kind: 'blocks', text }
}

function parse(schema: Schema, html: string): Fragment {
  const el = document.createElement('div')
  el.innerHTML = html
  return PMDOMParser.fromSchema(schema).parse(el).content
}

/** The result as content for `plan`: HTML for inline and blocks, list items for items. `heading` labels added text. */
export function resultContent(schema: Schema, plan: AiPlan, raw: string, heading?: string): string | Fragment {
  if (plan.kind === 'inline') return textToContent(raw)
  if (plan.kind === 'blocks') return (heading ? `<p><em>${heading}</em></p>` : '') + textToContent(raw, false)
  const blocks = parse(schema, textToContent(raw, false))
  const { listItem, paragraph } = schema.nodes
  if (plan.from === plan.to && heading) {
    // one item at the selection's depth: the label, with the result under it
    const label = paragraph.create(null, schema.text(heading, [schema.marks.italic.create()]))
    const inner: PMNode[] = [label]
    blocks.forEach(b => { inner.push(b) })
    return Fragment.from(listItem.create(null, inner))
  }
  const items: PMNode[] = []
  blocks.forEach(b => { if (isList(b)) b.forEach(li => { items.push(li) }); else items.push(listItem.create(null, b)) })
  return Fragment.from(items)
}

/** HTML to preview a result with (list items are shown as a list). */
export function previewHtml(schema: Schema, content: string | Fragment): string {
  if (typeof content === 'string') return content.startsWith('<') ? content : `<p>${content}</p>`
  const box = document.createElement('ul')
  box.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(content))
  return box.outerHTML
}
