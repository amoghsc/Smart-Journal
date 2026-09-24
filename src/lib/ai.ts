import type { Node as PMNode } from '@tiptap/pm/model'
import { supabase } from './supabase'

/**
 * AI tools run in the nt-ai edge function, which holds the Gemini key. Only the selected text is sent.
 *
 * To add a tool: add an entry to AI_TASKS here and a prompt with the same id in the function's TASKS map.
 */

export type AiTaskId = 'grammar' | 'shorten' | 'summarise' | 'expand' | 'simpler' | 'funny' | 'emotional' | 'metaphors'

export interface AiTask {
  id: AiTaskId
  label: string
  /** Shown while it runs, e.g. "Fixing grammar…". */
  busy: string
  /** replace: the result takes the selection's place. after: the result is added below it. */
  mode: 'replace' | 'after'
  /** For 'after' results: a short italic label above them, so they don't run into the text before. */
  heading?: string
  group: string
}

/** The menu, in order; groups become section headings. */
export const AI_TASKS: AiTask[] = [
  { id: 'grammar', label: 'Fix grammar', busy: 'Fixing grammar…', mode: 'replace', group: 'Fix' },
  { id: 'shorten', label: 'Make shorter', busy: 'Shortening…', mode: 'replace', group: 'Length' },
  { id: 'summarise', label: 'Summarise', busy: 'Summarising…', mode: 'replace', group: 'Length' },
  { id: 'expand', label: 'Expand', busy: 'Expanding…', mode: 'replace', group: 'Length' },
  { id: 'simpler', label: 'Simpler language', busy: 'Simplifying…', mode: 'replace', group: 'Tone' },
  { id: 'funny', label: 'Make it funny', busy: 'Adding humour…', mode: 'replace', group: 'Tone' },
  { id: 'emotional', label: 'More emotional', busy: 'Adding feeling…', mode: 'replace', group: 'Tone' },
  { id: 'metaphors', label: 'Metaphors to explain it', busy: 'Finding metaphors…', mode: 'after', heading: 'Metaphors', group: 'Explain' },
]

async function readError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try { const b = await ctx.json(); if (b?.error) return new Error(b.error) } catch { /* not JSON */ }
  }
  return error instanceof Error ? error : new Error(String(error))
}

let configured: Promise<boolean> | null = null
/** Is a Gemini key set on the server? Asked once per session. */
export function aiAvailable(): Promise<boolean> {
  configured ??= supabase.functions.invoke('nt-ai', { body: { action: 'status' } })
    .then(({ data, error }) => !error && !!data?.configured)
    .catch(() => false)
  return configured
}

export async function runAi(task: AiTaskId, text: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { task, text } })
  if (error) throw await readError(error)
  return (data?.text as string) ?? ''
}

// ---- selection ⇄ text -----------------------------------------------------------------------------
// The model sees light markup so structure survives a rewrite:
//   "- item" bullets, "1. item" numbered items, [[Note title]] note links, [words](https://…) web links.

/** The part of the document between `from` and `to` as marked-up text. */
export function selectionToText(doc: PMNode, from: number, to: number): string {
  const blocks: { text: string; list: 'bullet' | 'ordered' | null }[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    node.forEach((child, offset) => {
      const start = pos + 1 + offset, end = start + child.nodeSize
      if (end <= from || start >= to) return
      if (child.isText) {
        const piece = (child.text ?? '').slice(Math.max(0, from - start), Math.min(child.nodeSize, to - start))
        const link = child.marks.find(m => m.type.name === 'link')
        text += link ? `[${piece}](${link.attrs.href})` : piece
      } else if (child.type.name === 'wikilink') {
        text += `[[${child.attrs.title}]]`
      } else if (child.type.name === 'hardBreak') {
        text += ' '
      }
    })
    const $pos = doc.resolve(pos)
    let list: 'bullet' | 'ordered' | null = null
    for (let d = $pos.depth; d > 0; d--) {
      const n = $pos.node(d).type.name
      if (n === 'bulletList') { list = 'bullet'; break }
      if (n === 'orderedList') { list = 'ordered'; break }
    }
    if (text.trim()) blocks.push({ text: text.trim(), list })
    return false
  })
  let n = 0
  return blocks.map((b, i) => {
    const prev = blocks[i - 1]
    if (b.list !== 'ordered') n = 0
    const line = b.list === 'bullet' ? `- ${b.text}` : b.list === 'ordered' ? `${++n}. ${b.text}` : b.text
    return (i === 0 ? '' : prev?.list && prev.list === b.list ? '\n' : '\n\n') + line
  }).join('')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline markup → editor HTML: note links and web links come back as real links. */
function inline(s: string): string {
  return esc(s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/g, '$1$2'))
    .replace(/\[\[([^\][]+)\]\]/g, (_, t: string) => `<a class="wikilink" data-title="${t.trim()}">${t.trim()}</a>`)
    .replace(/\[([^\][]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, text: string, href: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`)
}

/**
 * AI output → editor HTML. Blank lines separate paragraphs; "- " and "1. " lines become lists.
 * A single plain paragraph comes back as inline HTML (when `allowInline`) so it can replace words mid-sentence.
 */
export function textToContent(raw: string, allowInline = true): string {
  const text = raw.replace(/^#+\s*/gm, '').trim()
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const isBullet = (l: string) => /^[-*•]\s+/.test(l)
  const isNumbered = (l: string) => /^\d+[.)]\s+/.test(l)
  if (allowInline && blocks.length === 1 && !blocks[0].split('\n').some(l => isBullet(l.trim()) || isNumbered(l.trim()))) {
    return inline(blocks[0].replace(/\s*\n\s*/g, ' '))
  }
  return blocks.map(b => {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.every(isBullet)) return `<ul>${lines.map(l => `<li><p>${inline(l.replace(/^[-*•]\s+/, ''))}</p></li>`).join('')}</ul>`
    if (lines.every(isNumbered)) return `<ol>${lines.map(l => `<li><p>${inline(l.replace(/^\d+[.)]\s+/, ''))}</p></li>`).join('')}</ol>`
    return `<p>${inline(lines.join(' '))}</p>`
  }).join('')
}
