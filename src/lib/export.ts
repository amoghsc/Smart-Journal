/**
 * Export one note as plain text, Markdown, a Word document (which Pages opens too) or PDF (through the browser's
 * print window — the one route that lays out Marathi and Hindi properly). The note's HTML is read once into a
 * simple list of blocks and runs; each format is written from that, so they all agree.
 * Comments and AI marks are left out (their text stays); note links keep their title.
 */

interface Run { text: string; bold?: boolean; italic?: boolean; strike?: boolean; highlight?: boolean; href?: string; note?: string }
// g: which top-level part of the note a block came from (a paragraph, a whole list…); parts are set apart by a blank line
type Block = { g: number } & (
  | { kind: 'p'; runs: Run[]; level: number }                                        // a paragraph (level > 0: inside a list item)
  | { kind: 'li'; runs: Run[]; level: number; ordered: boolean; n: number; list: number }
  | { kind: 'video'; url: string; level: number })

type Marks = Omit<Run, 'text'>

function inlineRuns(el: Node, marks: Marks, out: Run[]) {
  el.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) out.push({ ...marks, text: node.textContent }); return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const e = node as HTMLElement, tag = e.tagName
    if (tag === 'BR') { out.push({ ...marks, text: '\n' }); return }
    if (tag === 'A' && e.classList.contains('wikilink')) { const t = e.dataset.title || e.textContent || ''; out.push({ ...marks, text: e.textContent || t, note: t }); return }
    const next: Marks = { ...marks }
    if (tag === 'STRONG' || tag === 'B') next.bold = true
    if (tag === 'EM' || tag === 'I') next.italic = true
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true
    if (tag === 'MARK') next.highlight = true
    if (tag === 'A' && e.getAttribute('href')) next.href = e.getAttribute('href')!
    inlineRuns(e, next, out)
  })
}

/** A YouTube embed's address as a normal watch link. */
function videoUrl(el: HTMLElement): string {
  const src = el.querySelector('iframe')?.getAttribute('src') ?? el.getAttribute('data-src') ?? ''
  const id = /\/embed\/([\w-]{6,})/.exec(src)?.[1]
  return id ? `https://www.youtube.com/watch?v=${id}` : src
}

function readBlocks(html: string): Block[] {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const blocks: Block[] = []
  let lists = 0, g = 0
  const walk = (parent: Element, level: number) => {
    for (const el of parent.children) {
      if (level === 0) g++
      const tag = el.tagName
      if (el.hasAttribute('data-youtube-video')) { blocks.push({ g, kind: 'video', url: videoUrl(el as HTMLElement), level }); continue }
      if (tag === 'UL' || tag === 'OL') {
        const list = ++lists
        let n = 0
        for (const li of el.children) {
          if (li.tagName !== 'LI') continue
          n++
          let first = true
          for (const part of li.children) {
            if (part.tagName === 'UL' || part.tagName === 'OL') { walk({ children: [part] } as unknown as Element, level + 1); continue }
            const runs: Run[] = []
            inlineRuns(part, {}, runs)
            if (first) blocks.push({ g, kind: 'li', runs, level, ordered: tag === 'OL', n, list })
            else blocks.push({ g, kind: 'p', runs, level: level + 1 })
            first = false
          }
          if (first) blocks.push({ g, kind: 'li', runs: [], level, ordered: tag === 'OL', n, list })
        }
        continue
      }
      if (tag === 'BLOCKQUOTE' || tag === 'DIV') { walk(el, level); continue }
      const runs: Run[] = []
      inlineRuns(el, {}, runs)
      blocks.push({ g, kind: 'p', runs, level })
    }
  }
  walk(body, 0)
  return blocks
}

// ---- plain text ----------------------------------------------------------------------------------------------

const BULLETS = ['•', '◦', '▪']
const plain = (runs: Run[]) => runs.map(r => r.text).join('')

export function noteToText(title: string, html: string): string {
  const out: string[] = [title, '']
  let prev: Block | null = null
  for (const b of readBlocks(html)) {
    const pad = '    '.repeat(b.level)
    // a blank line between paragraphs and between lists; a list's items follow one another directly
    if (prev && prev.g !== b.g) out.push('')
    if (b.kind === 'video') out.push(pad + b.url)
    else if (b.kind === 'li') {
      const marker = b.ordered ? `${b.n}. ` : `${BULLETS[b.level % BULLETS.length]} `
      out.push(pad + marker + plain(b.runs).split('\n').join('\n' + pad + ' '.repeat(marker.length)))
    } else out.push(pad + plain(b.runs).split('\n').join('\n' + pad))
    prev = b
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---- Markdown --------------------------------------------------------------------------------------------------

const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>~=#|])/g, '\\$1')

function mdRuns(runs: Run[], pad: string): string {
  return runs.map(r => {
    if (r.text === '\n') return '  \n' + pad
    if (r.note) return r.text === r.note ? `[[${r.note}]]` : `[[${r.note}|${r.text}]]`
    const lead = r.text.match(/^\s*/)![0], trail = r.text.match(/\s*$/)![0], core = r.text.trim()
    if (!core) return r.text
    let t = mdEscape(core)
    if (r.highlight) t = `==${t}==`
    if (r.strike) t = `~~${t}~~`
    if (r.italic) t = `*${t}*`
    if (r.bold) t = `**${t}**`
    if (r.href) t = `[${t}](${r.href})`
    return lead + t + trail
  }).join('')
}

export function noteToMarkdown(title: string, html: string): string {
  const out: string[] = [`# ${title}`, '']
  // how far each nesting level is indented: the width of the list marker it sits under
  const indentAt: number[] = [0]
  let prev: Block | null = null
  for (const b of readBlocks(html)) {
    const pad = ' '.repeat(indentAt[b.level] ?? b.level * 3)
    if (prev && prev.g !== b.g) out.push('')
    if (b.kind === 'video') out.push(pad + b.url)
    else if (b.kind === 'li') {
      const marker = b.ordered ? `${b.n}. ` : '- '
      indentAt[b.level + 1] = pad.length + marker.length
      out.push(pad + marker + mdRuns(b.runs, pad + ' '.repeat(marker.length)))
    } else out.push(pad + mdRuns(b.runs, pad))
    prev = b
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---- Word (.docx) ----------------------------------------------------------------------------------------------

export async function noteToDocx(title: string, html: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, LevelFormat, AlignmentType } = await import('docx')
  const runsFor = (runs: Run[]) => runs.map(r => {
    if (r.text === '\n') return new TextRun({ break: 1 })
    const run = new TextRun({ text: r.text, bold: r.bold, italics: r.italic, strike: r.strike, highlight: r.highlight ? 'yellow' : undefined, style: r.href ? 'Hyperlink' : undefined })
    return r.href ? new ExternalHyperlink({ link: r.href, children: [run] }) : run
  })
  const paragraphs = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const b of readBlocks(html)) {
    if (b.kind === 'video') paragraphs.push(new Paragraph({ indent: b.level ? { left: 720 * b.level } : undefined, children: [new ExternalHyperlink({ link: b.url, children: [new TextRun({ text: b.url, style: 'Hyperlink' })] })] }))
    else if (b.kind === 'li') paragraphs.push(new Paragraph({
      children: runsFor(b.runs),
      ...(b.ordered ? { numbering: { reference: 'ordered', level: Math.min(b.level, 8), instance: b.list } } : { bullet: { level: Math.min(b.level, 8) } }),
    }))
    else paragraphs.push(new Paragraph({ children: runsFor(b.runs), indent: b.level ? { left: 720 * b.level } : undefined }))
  }
  const doc = new Document({
    creator: 'Smart Journal', title,
    numbering: { config: [{ reference: 'ordered', levels: Array.from({ length: 9 }, (_, level) => ({
      level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3], text: `%${level + 1}.`, alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })) }] },
    sections: [{ children: paragraphs }],
  })
  return Packer.toBlob(doc)
}

// ---- PDF (print) -----------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function htmlRuns(runs: Run[]): string {
  return runs.map(r => {
    if (r.text === '\n') return '<br>'
    let t = esc(r.text)
    if (r.highlight) t = `<mark>${t}</mark>`
    if (r.strike) t = `<s>${t}</s>`
    if (r.italic) t = `<em>${t}</em>`
    if (r.bold) t = `<strong>${t}</strong>`
    if (r.href) t = `<a href="${esc(r.href)}">${t}</a>`
    if (r.note) t = `<span class="note-link">${t}</span>`
    return t
  }).join('')
}

/** The note as a clean, print-ready page. */
function printHtml(title: string, html: string): string {
  const parts: string[] = []
  const open: ('ul' | 'ol')[] = []   // lists open at each level
  const closeTo = (level: number) => { while (open.length > level) parts.push(`</${open.pop()}>`) }
  for (const b of readBlocks(html)) {
    if (b.kind === 'li') {
      closeTo(b.level + 1)
      const want = b.ordered ? 'ol' : 'ul'
      if (open.length === b.level + 1 && open[b.level] !== want) closeTo(b.level)
      while (open.length < b.level + 1) { parts.push(`<${want}>`); open.push(want) }
      parts.push(`<li>${htmlRuns(b.runs)}</li>`)
    } else {
      closeTo(b.level)
      parts.push(b.kind === 'video' ? `<p><a href="${esc(b.url)}">${esc(b.url)}</a></p>` : `<p>${htmlRuns(b.runs)}</p>`)
    }
  }
  closeTo(0)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { margin: 2cm; }
body { margin: 0; color: #111; font: 12pt/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans Devanagari", "Kohinoor Devanagari", sans-serif; }
h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 14pt; }
p { margin: 0 0 7pt; } ul, ol { margin: 0 0 7pt; padding-left: 1.4em; } li { margin: 0 0 2pt; }
mark { background: #fff1a8; } s { color: #777; } a { color: #1a55c4; } .note-link { text-decoration: underline; text-decoration-color: #999; }
</style></head><body><h1>${esc(title)}</h1>${parts.join('')}</body></html>`
}

/** Open the browser's print window with just the note; "Save as PDF" there makes the file. */
export function printNote(title: string, html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' })
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open(); doc.write(printHtml(title, html)); doc.close()
  const win = frame.contentWindow!
  const done = () => setTimeout(() => frame.remove(), 500)
  win.addEventListener('afterprint', done)
  // let the fonts settle, then print; the page title becomes the suggested file name
  setTimeout(() => { win.focus(); win.print(); setTimeout(done, 60_000) }, 250)
}

// ---- saving ----------------------------------------------------------------------------------------------------

/** A file name from the note's title: letters of any script kept, characters file systems reject replaced. */
export const fileName = (title: string, ext: string) => `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'note'}.${ext}`

export function download(name: string, data: Blob | string, type = 'text/plain;charset=utf-8') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
