import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'

/**
 * Pasted text takes on the note's own look. From whatever it came from, only what the note itself can do survives —
 * bold, italic, strikethrough, highlight, links, and bullet or numbered lists; paragraphs become the note's
 * paragraphs. Fonts, sizes, colours, line and paragraph spacing, headings, quotes, tables and images are dropped,
 * and empty lines between paragraphs are removed. Text copied from a note in this app is left exactly as it was.
 */

const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER',
  'FOOTER', 'ASIDE', 'MAIN', 'NAV', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
  'DL', 'DT', 'DD', 'ADDRESS', 'CENTER', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'BODY', 'HTML'])
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'IMG', 'PICTURE', 'SVG', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT',
  'EMBED', 'CANVAS', 'HR', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE', 'MATH'])
const MARK_TAGS: Record<string, string> = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', S: 's', STRIKE: 's', DEL: 's', MARK: 'mark' }

/** Formatting an inline element carries in its style attribute (how Google Docs and many sites mark bold etc.). */
function styleMarks(el: HTMLElement): string[] {
  const st = el.style, out: string[] = []
  const weight = st.fontWeight
  if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) out.push('strong')
  if (st.fontStyle === 'italic') out.push('em')
  if (st.textDecoration.includes('line-through') || st.textDecorationLine.includes('line-through')) out.push('s')
  const bg = st.backgroundColor.replace(/\s/g, '')
  if (bg && !/^(transparent|white|#fff(fff)?|rgba?\(255,255,255(,1)?\)|rgba\(\d+,\d+,\d+,0\)|inherit|initial)$/i.test(bg)) out.push('mark')
  return out
}

const safeHref = (href: string | null) => (href && /^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : null)

export function cleanPastedHtml(html: string): string {
  // copied from a note in this app: ProseMirror tags its own clipboard HTML — keep note links, comments, AI marks
  if (/data-pm-slice/.test(html)) return html
  const src = new DOMParser().parseFromString(html, 'text/html').body
  const root = document.createElement('div')

  /** Where content goes: a container (the root, or a list item) and the paragraph currently being filled. */
  interface Sink { box: HTMLElement; para: HTMLElement | null }
  const para = (sink: Sink) => (sink.para ??= sink.box.appendChild(document.createElement('p')))
  const close = (sink: Sink) => { sink.para = null }

  const walk = (node: Node, sink: Sink, marks: string[], href: string | null) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/[\s ]+/g, ' ')
      if (!text.trim() && !sink.para) return   // whitespace between blocks
      let piece: Node = document.createTextNode(text)
      for (const m of [...marks].reverse()) { const w = document.createElement(m); w.appendChild(piece); piece = w }
      if (href) { const a = document.createElement('a'); a.href = href; a.appendChild(piece); piece = a }
      para(sink).appendChild(piece)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement, tag = el.tagName
    if (DROP.has(tag)) return
    if (tag === 'BR') {
      // two line breaks in a row start a new paragraph; one is a line break within it
      if (el.nextSibling && (el.nextSibling as Element).tagName === 'BR') { close(sink); return }
      if (sink.para && sink.para.lastChild && (sink.para.lastChild as Element).tagName !== 'BR') sink.para.appendChild(document.createElement('br'))
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      close(sink)
      const list = sink.box.appendChild(document.createElement(tag.toLowerCase()))
      for (const child of el.children) {
        if (child.tagName !== 'LI') continue
        const li = list.appendChild(document.createElement('li'))
        const inner: Sink = { box: li, para: null }
        child.childNodes.forEach(n => walk(n, inner, marks, href))
        if (!li.childNodes.length) li.remove()
      }
      if (!list.childNodes.length) list.remove()
      return
    }
    if (BLOCKS.has(tag) || tag === 'LI') {
      close(sink)
      el.childNodes.forEach(n => walk(n, sink, marks, href))
      close(sink)
      return
    }
    // inline: keep what the note can do, unwrap the rest
    const own = MARK_TAGS[tag]
    // Google Docs wraps a whole paste in <b style="font-weight:normal"> — that isn't bold
    const notBold = tag === 'B' && /^(normal|[1-5]00)$/.test(el.style.fontWeight)
    const next = [...marks, ...(own && !notBold ? [own] : []), ...styleMarks(el)].filter((m, i, all) => all.indexOf(m) === i)
    const link = tag === 'A' ? safeHref(el.getAttribute('href')) ?? href : href
    el.childNodes.forEach(n => walk(n, sink, next, link))
  }

  walk(src, { box: root, para: null }, [], null)

  // tidy: no empty paragraphs (the "blank line" gaps pasted text brings), no line breaks at a paragraph's ends
  root.querySelectorAll('p').forEach(p => {
    while (p.firstChild && (p.firstChild as Element).tagName === 'BR') p.firstChild.remove()
    while (p.lastChild && (p.lastChild as Element).tagName === 'BR') p.lastChild.remove()
    if (!p.textContent?.trim()) p.remove()
  })
  return root.innerHTML
}

/**
 * Plain pasted text: paragraphs at blank lines, a line break at a single newline, and no empty paragraphs.
 * Returned open at both ends so a one-line paste flows into the line you're on.
 */
export function plainTextSlice(schema: Schema, text: string): Slice {
  const { paragraph, hardBreak } = schema.nodes
  const paras: PMNode[] = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(block => block.split('\n').map(l => l.replace(/[\t ]+/g, ' ').trim()))
    .filter(lines => lines.some(Boolean))
    .map(lines => {
      const inline: PMNode[] = []
      lines.filter(Boolean).forEach((l, i) => { if (i) inline.push(hardBreak.create()); inline.push(schema.text(l)) })
      return paragraph.create(null, inline)
    })
  return paras.length ? new Slice(Fragment.from(paras), 1, 1) : Slice.empty
}
