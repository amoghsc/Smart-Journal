import DOMPurify from 'dompurify'
import { normTitle } from './links'

/** Page bodies are stored as the editor's HTML. These helpers read them without an editor. */

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-title', 'data-youtube-video', 'allowfullscreen', 'frameborder'], ADD_TAGS: ['iframe'] })
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Unique lower-cased titles a body links to via wikilink nodes (<a data-title="…">). */
export function extractLinks(html: string): string[] {
  if (typeof html !== 'string') return []
  const out = new Set<string>()
  for (const m of html.matchAll(/data-title="([^"]*)"/g)) {
    const t = normTitle(unescape(m[1]))
    if (t) out.add(t)
  }
  return [...out]
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Matches a wikilink anchor to `title` (case-insensitive), capturing its text. */
const linkRe = (title: string) => new RegExp(`<a\\b[^>]*\\bdata-title="${escapeRe(escapeAttr(title))}"[^>]*>([^<]*)</a>`, 'gi')

/** Turn every link to `title` back into plain text. */
export function unlinkTitle(html: string, title: string): string {
  if (typeof html !== 'string') return html   // never turn a missing body into an empty one
  return html.replace(linkRe(title), '$1')
}

/** Point every link to `from` at `to` instead. */
export function relinkTitle(html: string, from: string, to: string): string {
  if (typeof html !== 'string') return html
  return html.replace(linkRe(from), () => `<a class="wikilink" href="#" data-title="${escapeAttr(to)}">${escapeAttr(to)}</a>`)
}

/** Rough plain-text version for excerpts and search. */
export function plainText(html: string, max = 200): string {
  if (typeof html !== 'string') return ''
  const t = unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return max && t.length > max ? t.slice(0, max) + '…' : t
}

/** A note's word count, leaving out struck-through words (those are counted separately, as removed). */
export function wordStats(html: string): { words: number; struck: number } {
  if (typeof html !== 'string') return { words: 0, struck: 0 }
  const count = (h: string) => plainText(h, 0).split(/\s+/).filter(Boolean).length
  let struck = 0
  for (const m of html.matchAll(/<s(?:\s[^>]*)?>([\s\S]*?)<\/s>/g)) struck += count(m[1])
  return { words: Math.max(0, count(html) - struck), struck }
}
