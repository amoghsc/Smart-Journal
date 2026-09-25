import type { Node as PMNode } from '@tiptap/pm/model'
import { supabase } from './supabase'

/**
 * AI tools run in the nt-ai edge function, which holds the Gemini key. Only the selected text is sent.
 *
 * To add a tool: add an entry to AI_TASKS here and a prompt with the same id in the function's TASKS map.
 */

export type AiTaskId = 'synonyms' | 'grammar' | 'shorten' | 'summarise' | 'expand'
  | 'formal' | 'friendly' | 'genz' | 'simpler' | 'funny' | 'emotional' | 'sarcastic'
  | 'translate' | 'elaborate' | 'metaphors' | 'examples' | 'story' | 'structure' | 'forAgainst'

export interface AiTask {
  id: AiTaskId
  label: string
  /** Shown while it runs, e.g. "Fixing grammar…". */
  busy: string
  /** What the result is, for the hover label on a version, e.g. "expanded text". */
  result: string
  /**
   * replace: the result takes the selection's place. after: the result is added below it.
   * choose: the result is a list of options; picking one replaces the selection (keeping its formatting).
   */
  mode: 'replace' | 'after' | 'choose'
  /** Only offered when the selection is a single word. */
  wordOnly?: boolean
  /** For 'after' results: a short italic label above them, so they don't run into the text before. */
  heading?: string
  /** Menu section; sections are separated by a line. */
  group: number
}

/** The menu, in order. */
export const AI_TASKS: AiTask[] = [
  { id: 'synonyms', label: 'Similar Words', busy: 'Finding similar words…', result: 'similar words', mode: 'choose', wordOnly: true, group: 0 },
  { id: 'grammar', label: 'Fix Grammar', busy: 'Fixing grammar…', result: 'grammar fixed', mode: 'replace', group: 1 },
  { id: 'shorten', label: 'Shorten', busy: 'Shortening…', result: 'shortened text', mode: 'replace', group: 2 },
  { id: 'expand', label: 'Expand', busy: 'Expanding…', result: 'expanded text', mode: 'replace', group: 2 },
  { id: 'summarise', label: 'Summarise', busy: 'Summarising…', result: 'summary', mode: 'replace', group: 2 },
  { id: 'friendly', label: 'Friendly Tone', busy: 'Making it friendly…', result: 'friendly tone', mode: 'replace', group: 3 },
  { id: 'formal', label: 'Formal Tone', busy: 'Making it formal…', result: 'formal tone', mode: 'replace', group: 3 },
  { id: 'genz', label: 'Gen-z speak', busy: 'No cap, rewriting…', result: 'Gen-z speak', mode: 'replace', group: 3 },
  { id: 'simpler', label: 'Simpler Language', busy: 'Simplifying…', result: 'simpler language', mode: 'replace', group: 3 },
  { id: 'funny', label: 'Make it Funny', busy: 'Adding humour…', result: 'funny version', mode: 'replace', group: 4 },
  { id: 'emotional', label: 'Make it Emotional', busy: 'Adding feeling…', result: 'emotional version', mode: 'replace', group: 4 },
  { id: 'sarcastic', label: 'Make it Sarcastic', busy: 'Oh, great, rewriting…', result: 'sarcastic version', mode: 'replace', group: 4 },
  { id: 'translate', label: 'Translate', busy: 'Translating…', result: 'translation', mode: 'replace', group: 5 },
  { id: 'elaborate', label: 'Elaborate Idea', busy: 'Elaborating…', result: 'elaboration', mode: 'after', heading: 'Elaborated', group: 5 },
  { id: 'metaphors', label: 'Suggest Metaphors', busy: 'Finding metaphors…', result: 'metaphors', mode: 'after', heading: 'Metaphors', group: 5 },
  { id: 'examples', label: 'Suggest examples', busy: 'Finding examples…', result: 'examples', mode: 'after', heading: 'Examples', group: 5 },
  { id: 'story', label: 'Suggest a story', busy: 'Writing a story…', result: 'story', mode: 'after', heading: 'A story', group: 5 },
  { id: 'structure', label: 'Create Structure', busy: 'Outlining…', result: 'structure', mode: 'after', heading: 'Structure', group: 5 },
  { id: 'forAgainst', label: 'For & Against', busy: 'Weighing both sides…', result: 'for & against', mode: 'after', heading: 'For & against', group: 5 },
]

// ---- languages ---------------------------------------------------------------------------------------

export type Lang = 'en' | 'mr' | 'hi'
/** Translation targets, named in their own script. */
export const LANGS: Record<Lang, string> = { en: 'English', mr: 'मराठी', hi: 'हिंदी' }

// very common words that only one of the two languages uses (both are written in Devanagari)
const MARATHI = new Set('आहे आहेत आणि नाही नाहीत मी मला माझा माझी माझे तू तुला तुझा आम्ही तुम्ही आपण होते होता होती पण काय कसे कसा केले केला झाले झाला झाली आता खूप म्हणून असे असं नको कधी त्याला तिला त्यांना आहोत'.split(' '))
const HINDI = new Set('है हैं और नहीं मैं मुझे मेरा मेरी मेरे तुम था थी थे में से को यह वह क्या कैसे किया हुआ हुई अब बहुत हम लेकिन भी कि गया गई रहा रही हूँ हूं'.split(' '))

/**
 * The language most of `text` is in: English for Latin script, Marathi or Hindi for Devanagari (told apart by
 * common words and ळ, which Hindi doesn't use). Mixed text goes by whichever script has more letters. Null if neither.
 */
export function detectLanguage(text: string): Lang | null {
  const clean = text.replace(/\]\([^)]*\)/g, ' ')                // a web link's address isn't language
  const deva = (clean.match(/[\u0900-\u097F]/g) ?? []).length
  const latin = (clean.match(/[A-Za-z]/g) ?? []).length
  if (!deva && !latin) return null
  if (latin > deva) return 'en'
  let mr = (clean.match(/ळ/g) ?? []).length * 0.5, hi = 0
  // । and ॥ end words too
  for (const w of clean.split(/[^\u0900-\u0963\u0966-\u097F]+/)) { if (MARATHI.has(w)) mr++; if (HINDI.has(w)) hi++ }
  return hi > mr ? 'hi' : 'mr'
}

/** The two languages a passage can be translated into: the ones it isn't in. */
export function translateTargets(from: Lang | null): Lang[] {
  return (['en', 'mr', 'hi'] as Lang[]).filter(l => l !== from).slice(0, 2)
}

/** Extra details a task needs: the passage's main language, and for translate the target. */
export interface AiOpts { lang?: Lang | null; target?: Lang }

async function readError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try { const b = await ctx.json(); if (b?.error) return new Error(b.error) } catch { /* not JSON */ }
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** on: ready. unset: no Gemini key on the server yet. denied: this account isn't one of the people allowed to use it. */
export type AiStatus = 'on' | 'unset' | 'denied'

let status: Promise<AiStatus> | null = null
// asked once per sign-in (a different account may have different access)
supabase.auth.onAuthStateChange(e => { if (e === 'SIGNED_IN' || e === 'SIGNED_OUT') status = null })

/** Can this account use the AI tools? */
export function aiStatus(): Promise<AiStatus> {
  status ??= supabase.functions.invoke('nt-ai', { body: { action: 'status' } })
    .then(async ({ data, error }): Promise<AiStatus> => {
      if (error) return (error as { context?: Response }).context?.status === 403 ? 'denied' : 'unset'
      return data?.configured ? 'on' : 'unset'
    })
    .catch((): AiStatus => 'unset')
  return status
}

/** Two versions to choose between (one if both came out the same). */
export async function runAiOptions(task: AiTaskId, text: string, opts: AiOpts = {}): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { task, text, variants: 2, ...opts } })
  if (error) throw await readError(error)
  const texts = (data?.texts as string[] | undefined) ?? (data?.text ? [data.text as string] : [])
  return texts.filter(t => t && t.trim())
}

export async function runAi(task: AiTaskId, text: string, opts: AiOpts = {}): Promise<string> {
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { task, text, ...opts } })
  if (error) throw await readError(error)
  return (data?.text as string) ?? ''
}

// ---- selection ⇄ text -----------------------------------------------------------------------------
// The model sees light markup so structure survives a rewrite:
//   "- item" bullets, "1. item" numbered items, indented two spaces per nesting level (a list item's second
//   paragraph is indented without a marker), [[Note title]] note links, [words](https://…) web links.

/** The part of the document between `from` and `to` as marked-up text. */
export function selectionToText(doc: PMNode, from: number, to: number): string {
  const blocks: { text: string; list: 'bullet' | 'ordered' | null; level: number; more: boolean }[] = []
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
    let list: 'bullet' | 'ordered' | null = null, level = 0
    for (let d = $pos.depth; d > 0; d--) {
      const n = $pos.node(d).type.name
      if (n === 'bulletList' || n === 'orderedList') { list ??= n === 'bulletList' ? 'bullet' : 'ordered'; level++ }
    }
    // a second paragraph inside a list item continues that item
    const more = !!list && $pos.parent.type.name === 'listItem' && $pos.index() > 0
    if (text.trim()) blocks.push({ text: text.trim(), list, level, more })
    return false
  })
  // nesting is relative to the shallowest list in the selection
  const base = Math.min(...blocks.filter(b => b.list).map(b => b.level), Infinity)
  const counters: number[] = []
  return blocks.map((b, i) => {
    const prev = blocks[i - 1]
    const sep = i === 0 ? '' : prev?.list && b.list ? '\n' : '\n\n'
    if (!b.list) return sep + b.text
    const depth = b.level - base, pad = '  '.repeat(depth)
    if (b.more) return sep + pad + '  ' + b.text
    counters.length = depth + 1
    counters[depth] = b.list === 'ordered' ? (counters[depth] ?? 0) + 1 : 0
    return sep + pad + (b.list === 'bullet' ? '- ' : `${counters[depth]}. `) + b.text
  }).join('')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline markup → editor HTML: note links and web links come back as real links. */
function inline(s: string): string {
  return esc(s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/g, '$1$2'))
    .replace(/\[\[([^\][]+)\]\]/g, (_, t: string) => `<a class="wikilink" data-title="${t.trim()}">${t.trim()}</a>`)
    .replace(/\[([^\][]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, text: string, href: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`)
}

interface Item { indent: number; kind: 'ul' | 'ol'; text: string; more: string[] }

/** List lines → nested lists. Indent widths are ranked, so 2- and 4-space nesting both work. */
function listHtml(items: Item[]): string {
  const widths = [...new Set(items.map(it => it.indent))].sort((x, y) => x - y)
  const level = (it: Item) => widths.indexOf(it.indent)
  const item = (it: Item) => `<p>${inline(it.text)}</p>` + it.more.map(m => `<p>${inline(m)}</p>`).join('')
  let i = 0
  const list = (lvl: number): string => {
    const kind = items[i].kind
    let html = ''
    while (i < items.length && level(items[i]) >= lvl && (level(items[i]) > lvl || items[i].kind === kind)) {
      const it = items[i++]
      let inner = item(it)
      while (i < items.length && level(items[i]) > lvl) inner += list(level(items[i]))
      html += `<li>${inner}</li>`
    }
    return `<${kind}>${html}</${kind}>`
  }
  let out = ''
  while (i < items.length) out += list(level(items[i]))
  return out
}

/**
 * AI output → editor HTML. Blank lines separate paragraphs; "- " and "1. " lines become lists, nested by indent.
 * A single plain paragraph comes back as inline HTML (when `allowInline`) so it can replace words mid-sentence.
 */
export function textToContent(raw: string, allowInline = true): string {
  const lines = raw.replace(/^#+\s*/gm, '').replace(/\t/g, '    ').replace(/\s+$/, '').replace(/^\s*\n/, '').split('\n')
  let out = '', para: string[] = [], items: Item[] = [], paras = 0
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; paras++; para = [] } }
  const flushList = () => { if (items.length) { out += listHtml(items); items = [] } }
  for (const line of lines) {
    if (!line.trim()) { flushPara(); continue }
    const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (m) { flushPara(); items.push({ indent: m[1].length, kind: /\d/.test(m[2]) ? 'ol' : 'ul', text: m[3].trim(), more: [] }); continue }
    // an indented line under a list item is that item's next paragraph
    if (items.length && /^\s/.test(line) && !para.length) { items[items.length - 1].more.push(line.trim()); continue }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  // one plain paragraph can go mid-sentence
  if (allowInline && paras === 1 && out.startsWith('<p>') && out.endsWith('</p>') && !/<[uo]l>/.test(out)) return out.slice(3, -4)
  return out
}

// ---- single words ------------------------------------------------------------------------------------

/** The selection as a single word (any script), or null. */
export function singleWord(doc: PMNode, from: number, to: number): string | null {
  if (from === to) return null
  const $from = doc.resolve(from), $to = doc.resolve(to)
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  const w = doc.textBetween(from, to).trim()
  return w.length <= 40 && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*$/u.test(w) ? w : null
}

/** What the similar-words task is sent: the word, and the sentence it sits in for context. */
export function wordInContext(doc: PMNode, from: number, word: string): string {
  const sentence = doc.resolve(from).parent.textContent.replace(/\s+/g, ' ').trim().slice(0, 600)
  return `Word: ${word}\nSentence: ${sentence}`
}

/** One option per line → clean, distinct choices (never the word itself), capitalised like the original. */
export function parseChoices(raw: string, word: string, max = 8): string[] {
  const seen = new Set([word.toLowerCase()])
  const out: string[] = []
  for (let line of raw.split(/\n|,|;/)) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“'‘]+|["”'’.。।]+$/g, '').trim()
    if (!line || line.length > 40) continue
    const k = line.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    const cap = /^\p{Lu}/u.test(word) && /^\p{Ll}/u.test(line) ? line[0].toUpperCase() + line.slice(1) : line
    out.push(cap)
    if (out.length >= max) break
  }
  return out
}
