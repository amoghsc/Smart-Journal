/**
 * Find in a note's saved HTML, seeing its text the way the editor's find does (lib/noteSearch): line by line (each
 * paragraph, heading, list line or code block), with a note link or a line break counting as one stand-in character.
 * So a journal day shown as plain HTML counts and numbers its matches exactly as its editor would.
 *
 * Days shown as plain HTML are highlighted with the CSS Custom Highlight API (::highlight(find-hit)), which paints
 * ranges without touching the page's HTML. Browsers without it still count and jump to matches; they just don't
 * paint them until the day becomes editable.
 */

const LINES = 'p, h1, h2, h3, h4, h5, h6, pre'
const STAND_IN = '￼'
const ATOMS = 'a.wikilink, a[data-title], br'

interface Piece { node: Node; len: number; text: boolean }

/** The pieces of each line: text nodes as they are, a note link or line break as one character. */
function lines(root: ParentNode): Piece[][] {
  return [...root.querySelectorAll(LINES)].map(line => {
    const out: Piece[] = []
    const walk = (n: Node) => {
      n.childNodes.forEach(c => {
        if (c.nodeType === Node.TEXT_NODE) out.push({ node: c, len: c.textContent!.length, text: true })
        else if (c instanceof Element) { if (c.matches(ATOMS)) out.push({ node: c, len: 1, text: false }); else walk(c) }
      })
    }
    walk(line)
    return out
  })
}

const joined = (pieces: Piece[]) => pieces.map(p => (p.text ? p.node.textContent : STAND_IN)).join('')

/** Where character `at` of a line is in the page: a text node and offset, or beside a stand-in's element. */
function point(pieces: Piece[], at: number, end: boolean): [Node, number] {
  let pos = 0
  for (const p of pieces) {
    const next = pos + p.len
    if (end ? at <= next : at < next) {
      if (p.text) return [p.node, at - pos]
      const parent = p.node.parentNode!
      const i = Array.prototype.indexOf.call(parent.childNodes, p.node)
      return [parent, at === pos ? i : i + 1]
    }
    pos = next
  }
  const last = pieces[pieces.length - 1]
  return [last.node, last.text ? last.len : 0]
}

function each(text: string, q: string, f: (i: number) => void) {
  const lower = text.toLowerCase()
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) f(i)
}

/** Every match of `query` in the page under `root`, in order, as ranges. */
export function findRanges(root: ParentNode, query: string): Range[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const ranges: Range[] = []
  for (const pieces of lines(root)) {
    if (!pieces.length) continue
    each(joined(pieces), q, i => {
      const r = document.createRange()
      r.setStart(...point(pieces, i, false))
      r.setEnd(...point(pieces, i + q.length, true))
      ranges.push(r)
    })
  }
  return ranges
}

// each note's lines as text, kept while its HTML is unchanged (searching re-reads every day on each keystroke)
const texts = new Map<string, string[]>()

function lineTexts(html: string): string[] {
  let t = texts.get(html)
  if (!t) {
    if (texts.size > 800) texts.clear()
    // parsed into an inert document: nothing in it loads or runs
    const doc = new DOMParser().parseFromString(html, 'text/html')
    t = lines(doc.body).map(joined)
    texts.set(html, t)
  }
  return t
}

/** How many matches of `query` a note's saved HTML has. */
export function countMatches(html: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q || !html) return 0
  let n = 0
  for (const line of lineTexts(html)) each(line, q, () => { n++ })
  return n
}

// ---- highlights for days shown as plain HTML ----

type HighlightCtor = new (...ranges: Range[]) => { priority: number }
const registry = () => (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight

const shown = new Map<string, { ranges: Range[]; current: number }>()
let queued = false

function paint() {
  queued = false
  const reg = registry()
  if (!reg || !Highlight) return
  const all: Range[] = [], cur: Range[] = []
  for (const { ranges, current } of shown.values()) ranges.forEach((r, i) => (i === current ? cur : all).push(r))
  if (!all.length && !cur.length) { reg.delete('find-hit'); reg.delete('find-current'); return }
  reg.set('find-hit', new Highlight(...all))
  const c = new Highlight(...cur)
  c.priority = 1
  reg.set('find-current', c)
}

/** Show (or with null, clear) the matches in the plain-HTML day `key`; `current` is the one to stress, or -1. */
export function setShownMatches(key: string, ranges: Range[] | null, current = -1) {
  if (ranges?.length) shown.set(key, { ranges, current }); else shown.delete(key)
  if (!queued) { queued = true; queueMicrotask(paint) }
}

/** The ranges last shown for day `key`, if it's shown as plain HTML. */
export const shownMatches = (key: string): Range[] | undefined => shown.get(key)?.ranges
