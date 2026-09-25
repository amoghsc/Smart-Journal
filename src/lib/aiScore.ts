import type { MarkType, Node as PMNode } from '@tiptap/pm/model'
import { supabase } from './supabase'

/**
 * AI score: how much of a piece of AI-written text is still the AI's, comparing it now with the text as the AI
 * wrote it (stored in nt_ai_pieces). Each part is an AI share from 0 to 1 — higher means more of it is the AI's:
 *
 *   words      50%  the AI's words still there, in order (spaces, punctuation and case don't count)
 *   sentences  30%  the AI's sentences that haven't been substantially rewritten
 *   meaning    20%  how close the meaning still is (Gemini embeddings; optional, see settings)
 *
 * Without the meaning part, words and sentences share the score 62.5 / 37.5. A piece counts as completely
 * rewritten — and loses its marker — once none of the AI's wording is left (words and sentences both 0).
 */

export interface Score {
  ai: number
  words: number
  sentences: number
  /** null when not used (switched off) or not known yet. */
  meaning: number | null
  /** The meaning part is from an earlier version of the text; a fresh check is due. */
  stale: boolean
  rewritten: boolean
}

interface Piece { original: string; meaning: number | null; meaningOf: string | null }
const pieces = new Map<string, Piece>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---- comparing ------------------------------------------------------------------------------------------

/** Words in any script, lower-cased, without punctuation. */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []

/** Matched positions of the longest common subsequence of two word lists. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length
  if (!n || !m) return []
  if (n * m > 4_000_000) {
    // very long pieces: match greedily in order instead
    const out: [number, number][] = []
    let j = 0
    for (let i = 0; i < n && j < m; i++) { const k = b.indexOf(a[i], j); if (k >= 0 && k - j < 50) { out.push([i, k]); j = k + 1 } }
    return out
  }
  const w = m + 1, dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  const out: [number, number][] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return out
}

/** Share of the AI's words still in place. Lone shared words ("the", "and") are coincidence, so only runs of two or more count. */
export function wordShare(a: string[], b: string[]): number {
  const max = Math.max(a.length, b.length)
  if (!max) return 0
  const pairs = lcsPairs(a, b)
  if (Math.min(a.length, b.length) < 3) return pairs.length / max
  let kept = 0, run = 0
  pairs.forEach(([i, j], k) => {
    run++
    const next = pairs[k + 1]
    if (!next || next[0] !== i + 1 || next[1] !== j + 1) { if (run >= 2) kept += run; run = 0 }
  })
  return kept / max
}

const sentences = (s: string) => s.split(/(?<=[.!?।॥])\s+|\n+/).map(words).filter(w => w.length)

/** Share of sentences that are still the AI's: at least 60% of their words survive, in order. */
export function sentenceShare(original: string, current: string): number {
  const sa = sentences(original), sb = sentences(current)
  const max = Math.max(sa.length, sb.length)
  if (!max) return 0
  const used = new Set<number>()
  let kept = 0
  for (const s of sb) {
    let best = -1, bestRatio = 0
    sa.forEach((o, i) => {
      if (used.has(i)) return
      const r = lcsPairs(o, s).length / Math.max(o.length, s.length)
      if (r > bestRatio) { bestRatio = r; best = i }
    })
    if (best >= 0 && bestRatio >= 0.6) { used.add(best); kept++ }
  }
  return kept / max
}

/** A short fingerprint of the words (so a comma or a space doesn't make the text "different"). */
export function wordsHash(s: string): string {
  let h = 0x811c9dc5
  for (const ch of words(s).join(' ')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}

// ---- pieces in a note -----------------------------------------------------------------------------------

/** Each AI piece's current text in `doc`: its marked text, one line per paragraph. */
export function pieceTexts(doc: PMNode, type: MarkType): Map<string, string> {
  const lines = new Map<string, string[]>()
  doc.descendants(node => {
    if (!node.isTextblock) return true
    const here = new Map<string, string>()
    node.forEach(child => {
      const id = child.marks.find(m => m.type === type)?.attrs.id as string | undefined
      if (!id) return
      const t = child.isText ? child.text! : child.type.name === 'wikilink' ? String(child.attrs.title) : ' '
      here.set(id, (here.get(id) ?? '') + t)
    })
    for (const [id, t] of here) lines.set(id, [...(lines.get(id) ?? []), t])
    return false
  })
  return new Map([...lines].map(([id, l]) => [id, l.join('\n').trim()]))
}

/** Remember a piece the AI just wrote, as written. */
export async function recordPiece(id: string, original: string, task?: string, pageId?: string) {
  const meaningOf = wordsHash(original)
  pieces.set(id, { original, meaning: 1, meaningOf })
  const { error } = await supabase.from('nt_ai_pieces')
    .upsert({ id, original, task: task ?? null, page_id: pageId ?? null, meaning: 1, meaning_of: meaningOf }, { onConflict: 'id', ignoreDuplicates: true })
  if (error) console.warn('ai score: could not save piece', error.message)
}

/** Fetch the originals of these pieces. Pieces marked before scores existed start from their current text. */
export async function loadPieces(current: Map<string, string>): Promise<void> {
  const missing = [...current.keys()].filter(id => !pieces.has(id) && UUID.test(id))
  if (!missing.length) return
  const { data, error } = await supabase.from('nt_ai_pieces').select('id, original, meaning, meaning_of').in('id', missing)
  if (error) throw error
  for (const r of data ?? []) pieces.set(r.id as string, { original: r.original as string, meaning: r.meaning as number | null, meaningOf: r.meaning_of as string | null })
  const unknown = missing.filter(id => !pieces.has(id))
  if (!unknown.length) return
  const rows = unknown.map(id => ({ id, original: current.get(id)!, meaning: 1, meaning_of: wordsHash(current.get(id)!) }))
  for (const r of rows) pieces.set(r.id, { original: r.original, meaning: 1, meaningOf: r.meaning_of })
  const { error: e2 } = await supabase.from('nt_ai_pieces').upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
  if (e2) console.warn('ai score: could not save pieces', e2.message)
}

/** The score of piece `id` with its text now. `gemini`: include the meaning part. Null until its original is loaded. */
export function scoreFor(id: string, current: string, gemini: boolean): Score | null {
  const p = pieces.get(id)
  if (!p) return null
  const w = wordShare(words(p.original), words(current))
  const s = sentenceShare(p.original, current)
  const h = wordsHash(current), same = h === wordsHash(p.original)
  // same words as the AI wrote: same meaning, no need to ask. Otherwise the last check stands until the next one.
  const meaning = !gemini ? null : same ? 1 : p.meaning
  const stale = gemini && !same && p.meaningOf !== h
  const ai = meaning == null ? (0.5 * w + 0.3 * s) / 0.8 : 0.5 * w + 0.3 * s + 0.2 * meaning
  return { ai, words: w, sentences: s, meaning, stale, rewritten: w === 0 && s === 0 }
}

/** Does piece `id` need a fresh meaning check for this text? */
export function meaningDue(id: string, current: string): boolean {
  const p = pieces.get(id)
  if (!p) return false
  const h = wordsHash(current)
  return h !== wordsHash(p.original) && p.meaningOf !== h
}

// cosine similarity of the two embeddings → AI share of the meaning: unrelated texts sit around 0.7, close paraphrases above 0.95
const LOW = 0.7, HIGH = 0.95

/** Ask Gemini how close the meaning still is, and store it. Quietly gives up (quota, offline). */
export async function checkMeaning(id: string, current: string): Promise<void> {
  const p = pieces.get(id)
  if (!p) return
  const h = wordsHash(current)
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { action: 'meaning', a: p.original, b: current } })
  if (error || typeof data?.similarity !== 'number') { console.warn('ai score: meaning check failed', error?.message ?? data); return }
  p.meaning = Math.min(1, Math.max(0, (data.similarity - LOW) / (HIGH - LOW)))
  p.meaningOf = h
  const { error: e2 } = await supabase.from('nt_ai_pieces').update({ meaning: p.meaning, meaning_of: h, updated_at: new Date().toISOString() }).eq('id', id)
  if (e2) console.warn('ai score: could not save meaning', e2.message)
}
