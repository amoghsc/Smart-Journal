import { strFromU8, unzipSync } from 'fflate'

/**
 * Import notes from Obsidian, Logseq or Roam into Smart Journal's own HTML, keeping what makes them a graph:
 * [[links]] (and #tags in Logseq and Roam, which are links there) become note links, so backlinks work; daily
 * notes become journal days (YYYY-MM-DD), and links to them follow; website links stay links.
 * Images aren't stored yet: a web image becomes a link to it, a local one a small "🖼 name" marker.
 */

export type Source = 'obsidian' | 'logseq' | 'roam'
export const SOURCE_NAMES: Record<Source, string> = { obsidian: 'Obsidian', logseq: 'Logseq', roam: 'Roam' }

export interface ImportedNote { title: string; body: string; created_at?: string; updated_at?: string }
export interface ImportPlan {
  source: Source
  notes: ImportedNote[]
  days: number
  pages: number
  links: number
  /** Image files, and image embeds pointing at files on disk (not imported). */
  images: number
  /** Files that couldn't be read. */
  skipped: string[]
}

interface InFile { path: string; text: string; modified?: number }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|heif|bmp|avif)$/i

// ---- reading what was picked: a folder, .md files, a .json (Roam) or a .zip of any of these ----

export async function readPicked(files: File[]): Promise<{ files: InFile[]; imageFiles: number }> {
  const out: InFile[] = []
  let imageFiles = 0, obsidian = false
  const junk = /(^|\/)(node_modules|\.trash|\.git|__MACOSX)\/|(^|\/)logseq\/(bak|\.recycle|version-files)\//
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    if (junk.test(path)) continue
    // Obsidian's settings folder only tells us it's an Obsidian vault
    if (/(^|\/)\.obsidian\//.test(path)) { if (!obsidian) out.push({ path, text: '' }); obsidian = true; continue }
    if (/\.zip$/i.test(path)) {
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()))
      for (const [p, data] of Object.entries(entries)) {
        if (IMAGE.test(p)) { imageFiles++; continue }
        if (/\.(md|markdown|json)$/i.test(p) && !/(^|\/)(__MACOSX|\.trash)\//.test(p)) out.push({ path: p, text: strFromU8(data) })
      }
    } else if (IMAGE.test(path)) imageFiles++
    else if (/\.(md|markdown|json)$/i.test(path) || path.endsWith('config.edn')) out.push({ path, text: await f.text(), modified: f.lastModified })
  }
  return { files: out, imageFiles }
}

export function detect(files: InFile[]): Source | null {
  if (files.some(f => /\.json$/i.test(f.path) && /^\s*\[\s*\{[\s\S]*"title"/.test(f.text.slice(0, 2000)))) return 'roam'
  if (files.some(f => /(^|\/)logseq\/config\.edn$/.test(f.path) || /(^|\/)journals\/\d{4}_\d{2}_\d{2}\.md$/.test(f.path))) return 'logseq'
  if (files.some(f => /(^|\/)\.obsidian\//.test(f.path))) return 'obsidian'
  const md = files.filter(f => /\.md$/i.test(f.path))
  if (!md.length) return null
  // Roam's Markdown export: every page an outline, daily pages named "September 28th, 2026"
  if (md.some(f => /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}\.md$/.test(f.path))) return 'roam'
  return 'obsidian'
}

// ---- dates: every app names its daily notes its own way ----

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
function ymd(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
}
/** A daily-note title in any of the usual formats → YYYY-MM-DD, else null. */
export function dayOf(title: string): string | null {
  const s = title.trim()
  let m = s.match(/^(\d{4})[-_./](\d{1,2})[-_./](\d{1,2})$/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  // "September 28th, 2026", "Sep 28th, 2026", "Sep 28, 2026", "Monday, September 28, 2026"
  m = s.match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/)
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) return ymd(+m[3], mi + 1, +m[2]) }
  // "28 Sep 2026", "28th September 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/)
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return ymd(+m[3], mi + 1, +m[1]) }
  return null
}

// ---- inline Markdown (each app's flavour) → HTML ----

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

interface Ctx {
  flavor: Source
  /** A link target as written → the note it should point to. */
  target: (raw: string) => string
  /** Roam block references: uid → the block's text. */
  blocks?: Map<string, string>
  stats: { links: number; images: number }
}

function wikilink(title: string, ctx: Ctx): string {
  const t = ctx.target(title)
  if (!t) return ''
  ctx.stats.links++
  return `<a class="wikilink" data-title="${esc(t)}">${esc(t)}</a>`
}

function image(alt: string, src: string, ctx: Ctx): string {
  ctx.stats.images++
  const name = alt || decodeURIComponent(src.split('/').pop() ?? 'image')
  // a picture on the web stays one click away; one on disk is marked, for when photos can be imported
  return /^https?:\/\//i.test(src)
    ? `<a href="${esc(src)}" target="_blank" rel="noopener">🖼 ${esc(name)}</a>`
    : `<em>🖼 ${esc(name)}</em>`
}

export function inline(src: string, ctx: Ctx): string {
  const keep: string[] = []
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`
  let s = src
  // code first: nothing inside it is formatting
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${esc(c)}</code>`))
  if (ctx.flavor !== 'obsidian') {
    // Roam/Logseq extras: {{[[TODO]]}} / TODO / DONE, ((block refs)), [alias]([[Page]])
    s = s.replace(/\{\{\[\[TODO\]\]\}\}\s*|^(TODO|LATER|NOW|DOING)\s+/g, () => '☐ ')
    s = s.replace(/\{\{\[\[DONE\]\]\}\}\s*|^(DONE)\s+/g, () => '☑ ')
    // a block reference shows the block it points to (one level deep)
    s = s.replace(/\(\(([\w-]{6,})\)\)/g, (_, uid: string) => { const t = ctx.blocks?.get(uid); return t ? hold(`<em>${inline(t, { ...ctx, blocks: undefined })}</em>`) : '' })
    // tags are links in Logseq and Roam
    s = s.replace(/(^|\s)#\[\[([^\]]+)\]\]/g, (_, pre: string, t: string) => pre + hold(wikilink(t, ctx)))
    s = s.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_, _alias: string, t: string) => hold(wikilink(t, ctx)))
    s = s.replace(/\{\{[^}]*\}\}/g, '')
  } else {
    s = s.replace(/%%[\s\S]*?%%/g, '')
  }
  // images, then embeds and links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt: string, url: string) => hold(image(alt, url, ctx)))
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, t: string) => {
    const name = t.split('|')[0]
    return hold(IMAGE.test(name) ? image('', name, ctx) : wikilink(name.split('#')[0], ctx))
  })
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => hold(wikilink(t.split('|')[0].split('#')[0], ctx)))
  s = s.replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, (_, text: string, url: string) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${inline(text, { ...ctx })}</a>`))
  s = s.replace(/<((?:https?:)[^>\s]+)>/g, (_, url: string) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`))
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre: string, url: string) => pre + hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`))
  if (ctx.flavor !== 'obsidian') {
    s = s.replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (_, pre: string, t: string) => pre + hold(wikilink(t, ctx)))
  }
  s = esc(s)
  // emphasis (Roam: __italic__ and ^^highlight^^)
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
  s = ctx.flavor === 'roam' ? s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<em>$1</em>') : s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
  s = s.replace(/\^\^(?=\S)([\s\S]*?\S)\^\^/g, '<mark>$1</mark>')
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[+i])
}

// ---- blocks: headings, lists (the whole page, in Logseq and Roam), quotes, code, paragraphs ----

interface Item { indent: number; ordered: boolean; lines: string[]; children: Item[] }

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const PROPERTY = /^\s*[\w-]+::\s?/
const width = (ws: string) => ws.replace(/\t/g, '    ').length

function listHtml(items: Item[], ctx: Ctx): string {
  if (!items.length) return ''
  // bullets then numbers at the same level are two lists
  const cut = items.findIndex(it => it.ordered !== items[0].ordered)
  if (cut > 0) return listHtml(items.slice(0, cut), ctx) + listHtml(items.slice(cut), ctx)
  const tag = items[0].ordered ? 'ol' : 'ul'
  const lis = items.map(it => {
    const [first, ...rest] = it.lines
    const hm = first.match(/^(#{1,6})\s+(.*)$/)
    // a heading inside a bullet reads as a bold line (the editor has no headings in lists)
    const head = hm ? `<strong>${inline(hm[2], ctx)}</strong>` : inline(first, ctx)
    const body = [head, ...rest.map(l => inline(l, ctx))].join('<br>')
    return `<li><p>${body}</p>${listHtml(it.children, ctx)}</li>`
  }).join('')
  return `<${tag}>${lis}</${tag}>`
}

export function markdownToHtml(text: string, ctx: Ctx): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
  const out: string[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { out.push(`<p>${para.map(l => inline(l, ctx)).join('<br>')}</p>`); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Logseq/Roam block properties (id::, collapsed::, title::) aren't text
    if (ctx.flavor !== 'obsidian' && PROPERTY.test(line) && !LIST.test(line)) continue
    if (!line.trim()) { flush(); continue }
    const fence = line.match(/^\s*```/)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flush(); out.push(`<h${Math.min(3, h[1].length)}>${inline(h[2], ctx)}</h${Math.min(3, h[1].length)}>`); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue }
    if (/^\s*>/.test(line)) {
      flush()
      const q: string[] = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, '').replace(/^\[!(\w+)\][-+]?\s*/, (_, k: string) => `${k[0].toUpperCase()}${k.slice(1)}: `))
      i--
      out.push(`<blockquote>${q.filter(l => l.trim()).map(l => `<p>${inline(l, ctx)}</p>`).join('')}</blockquote>`)
      continue
    }
    const li = line.match(LIST)
    if (li) {
      flush()
      // a list: items nest by indent; lines indented under an item (not starting a new one) continue it
      const roots: Item[] = [], stack: Item[] = []
      for (; i < lines.length; i++) {
        const l = lines[i]
        if (!l.trim()) { if (lines[i + 1]?.match(LIST)) continue; break }
        const m = l.match(LIST)
        if (m) {
          const it: Item = { indent: width(m[1]), ordered: /\d/.test(m[2]), lines: [m[3]], children: [] }
          while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop()
          ;(stack.length ? stack[stack.length - 1].children : roots).push(it)
          stack.push(it)
        } else if (stack.length && /^\s/.test(l)) {
          if (ctx.flavor !== 'obsidian' && PROPERTY.test(l)) continue
          if (/^\s*```/.test(l)) {
            const code: string[] = []
            for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i].trim())
            stack[stack.length - 1].lines.push(`\`${code.join(' ')}\``)
            continue
          }
          stack[stack.length - 1].lines.push(l.trim())
        } else break
      }
      i--
      // a Logseq/Roam page's own properties block (title::, alias::) is empty once they're dropped
      const clean = (items: Item[]): Item[] => items
        .map(it => ({ ...it, lines: it.lines.filter(l => !(ctx.flavor !== 'obsidian' && PROPERTY.test(l))), children: clean(it.children) }))
        .filter(it => it.lines.some(l => l.trim()) || it.children.length)
        .map(it => (it.lines.length ? it : { ...it, lines: [''] }))
      out.push(listHtml(clean(roots), ctx))
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out.join('') || '<p></p>'
}

// ---- whole imports ----

interface Raw { title: string; text?: string; roam?: RoamBlock[]; created?: number; updated?: number }
interface RoamBlock { string?: string; uid?: string; heading?: number; children?: RoamBlock[] }
interface RoamPage { title: string; children?: RoamBlock[]; 'create-time'?: number; 'edit-time'?: number }

const base = (p: string) => p.split('/').pop()!.replace(/\.(md|markdown)$/i, '')

function logseqTitle(path: string, text: string): string {
  const prop = text.match(/^(?:-\s*)?title::\s*(.+)$/m)
  if (prop) return prop[1].trim()
  const j = path.match(/(?:^|\/)journals\/(\d{4})_(\d{2})_(\d{2})\.md$/)
  if (j) return `${j[1]}-${j[2]}-${j[3]}`
  let t = base(path).replace(/___/g, '/').replace(/%2F/gi, '/')
  try { t = decodeURIComponent(t) } catch { /* not encoded */ }
  return t
}

function roamHtml(blocks: RoamBlock[], ctx: Ctx): string {
  if (!blocks.length) return ''
  return `<ul>${blocks.map(b => {
    const s = b.string ?? ''
    const text = b.heading ? `<strong>${inline(s, ctx)}</strong>` : s.split('\n').map(l => inline(l, ctx)).join('<br>')
    return `<li><p>${text}</p>${roamHtml(b.children ?? [], ctx)}</li>`
  }).join('')}</ul>`
}

export function planImport(files: InFile[], source: Source, imageFiles: number): ImportPlan {
  const skipped: string[] = []
  let raws: Raw[] = []
  const blocks = new Map<string, string>()
  if (source === 'roam' && files.some(f => /\.json$/i.test(f.path))) {
    for (const f of files.filter(x => /\.json$/i.test(x.path))) {
      try {
        const pages = JSON.parse(f.text) as RoamPage[]
        const walk = (bs: RoamBlock[] = []) => bs.forEach(b => { if (b.uid && b.string) blocks.set(b.uid, b.string); walk(b.children) })
        for (const p of pages) { walk(p.children); raws.push({ title: p.title, roam: p.children ?? [], created: p['create-time'], updated: p['edit-time'] }) }
      } catch { skipped.push(f.path) }
    }
  } else {
    const md = files.filter(f => /\.(md|markdown)$/i.test(f.path) && !/(^|\/)(\.obsidian|logseq)\//.test(f.path))
    // Logseq block references: a block's "id:: …" belongs to the bullet just above it
    if (source === 'logseq') for (const f of md) {
      let last = ''
      for (const line of f.text.split('\n')) {
        const b = line.match(LIST)
        if (b) last = b[3]
        const id = line.match(/^\s*id::\s*([\w-]+)/)
        if (id && last) blocks.set(id[1], last)
      }
    }
    raws = md.map(f => ({
      title: source === 'logseq' ? logseqTitle(f.path, f.text) : base(f.path),
      text: f.text, created: f.modified, updated: f.modified,
    }))
    // Logseq's own pages folder only (skip version files etc.)
    if (source === 'logseq') raws = raws.filter((_, i) => /(^|\/)(pages|journals)\//.test(md[i].path) || !md.some(x => /(^|\/)(pages|journals)\//.test(x.path)))
  }

  // final titles: days as YYYY-MM-DD, and no two notes with the same name (ignoring case)
  const finalOf = new Map<string, string>()
  const taken = new Set<string>()
  const named: { raw: Raw; title: string; day: boolean }[] = []
  for (const raw of raws) {
    const d = dayOf(raw.title)
    let title = (d ?? raw.title.replace(/[\u0000-\u001f]/g, '').trim()) || 'Untitled'
    const key = title.toLowerCase()
    if (d && taken.has(key)) { const same = named.find(n => n.title.toLowerCase() === key)!.raw; if (same.text != null) same.text += '\n\n' + (raw.text ?? ''); continue }  // the same day twice: one note
    let n = 1
    while (taken.has(title.toLowerCase())) title = `${d ?? raw.title} (${++n})`
    taken.add(title.toLowerCase())
    finalOf.set(raw.title.toLowerCase(), title)
    named.push({ raw, title, day: !!d })
  }
  const stats = { links: 0, images: 0 }
  const ctx: Ctx = {
    flavor: source, blocks, stats,
    target: t => {
      const clean = t.trim().replace(/\.md$/i, '')
      const byFull = finalOf.get(clean.toLowerCase())
      if (byFull) return byFull
      // Obsidian links by file name: "folder/Note" → "Note"
      const short = finalOf.get(clean.split('/').pop()!.toLowerCase())
      if (short && source === 'obsidian') return short
      return dayOf(clean) ?? clean
    },
  }
  const iso = (t?: number) => (t && t > 0 ? new Date(t).toISOString() : undefined)
  const notes = named.map(({ raw, title }) => ({
    title,
    body: raw.roam ? (roamHtml(raw.roam, ctx) || '<p></p>') : markdownToHtml(raw.text ?? '', ctx),
    created_at: iso(raw.created), updated_at: iso(raw.updated),
  }))
  return {
    source, notes, skipped,
    days: named.filter(n => n.day).length, pages: named.filter(n => !n.day).length,
    links: stats.links, images: stats.images + imageFiles,
  }
}
