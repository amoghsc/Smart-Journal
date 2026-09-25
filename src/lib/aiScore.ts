import type { MarkType, Node as PMNode } from '@tiptap/pm/model'
import { supabase } from './supabase'

/**
 * AI score: how much of a piece of AI-written text is the AI's. It compares three versions, stored in nt_ai_pieces:
 * your text before the AI touched it (the seed — none when the AI wrote something new), the text as the AI wrote
 * it, and the text now. Only what the AI brought counts as the AI's: a grammar fix of your paragraph scores low,
 * a story it wrote from scratch starts at 100%, and your later edits bring either down. Each part is an AI share
 * from 0 to 1:
 *
 *   words      50%  words the AI introduced that are still there, in order (spaces, punctuation and case don't count)
 *   sentences  30%  sentences the AI wrote (not near-copies of yours) that haven't been substantially rewritten
 *   meaning    20%  how far the AI moved the meaning from your text, times how much of its meaning is still there
 *                   (Gemini embeddings; optional, see settings)
 *
 * Without the meaning part, words and sentences share the score 62.5 / 37.5. A piece with none of the AI's wording
 * left counts as yours, and loses its marker.
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
  /** The AI worked from your text (rather than writing something new). */
  seeded: boolean
}

interface Piece {
  original: string
  seed: string | null
  /** How far the AI moved the meaning from the seed (1 without a seed; null until checked). */
  seedMeaning: number | null
  /** How much of the AI's meaning is still there, for the text hashed as `meaningOf`. */
  meaning: number | null
  meaningOf: string | null
}
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

/** Words of `a` still in `b`, in order. Lone shared words ("the", "and") are coincidence, so only runs of two or more count. */
function keptPairs(a: string[], b: string[]): [number, number][] {
  const pairs = lcsPairs(a, b)
  if (Math.min(a.length, b.length) < 3) return pairs
  const out: [number, number][] = []
  let run: [number, number][] = []
  pairs.forEach((p, k) => {
    run.push(p)
    const next = pairs[k + 1]
    if (!next || next[0] !== p[0] + 1 || next[1] !== p[1] + 1) { if (run.length >= 2) out.push(...run); run = [] }
  })
  return out
}

/** Share of the text now that is words the AI introduced (not ones it kept from your seed). */
export function wordShare(ai: string[], now: string[], seed: string[] | null): number {
  const max = Math.max(ai.length, now.length)
  if (!max) return 0
  const fromSeed = new Set(seed ? keptPairs(seed, ai).map(([, j]) => j) : [])
  return keptPairs(ai, now).filter(([i]) => !fromSeed.has(i)).length / max
}

const sentences = (s: string) => s.split(/(?<=[.!?।॥])\s+|\n+/).map(words).filter(w => w.length)
const likeness = (x: string[], y: string[]) => lcsPairs(x, y).length / Math.max(x.length, y.length, 1)

/** Share of sentences now that the AI wrote (not near-copies of yours) and that haven't been substantially rewritten. */
export function sentenceShare(ai: string, now: string, seed: string | null): number {
  const sa = sentences(ai), sb = sentences(now), ss = seed ? sentences(seed) : []
  const max = Math.max(sa.length, sb.length)
  if (!max) return 0
  const aiWrote = sa.map(s => !ss.some(x => likeness(x, s) >= 0.6))
  const used = new Set<number>()
  let kept = 0
  for (const s of sb) {
    let best = -1, bestRatio = 0
    sa.forEach((o, i) => {
      if (used.has(i)) return
      const r = likeness(o, s)
      if (r > bestRatio) { bestRatio = r; best = i }
    })
    if (best >= 0 && bestRatio >= 0.6) { used.add(best); if (aiWrote[best]) kept++ }
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

/** Fired on window when a piece has been recorded, so its note can score it (and check the meaning) right away. */
export const PIECE_EVENT = 'sj-ai-piece'

/** Remember a piece the AI just wrote, as written, and your text it replaced (`seed`; none for new writing). */
export async function recordPiece(id: string, original: string, seed: string | null, task?: string, pageId?: string) {
  const meaningOf = wordsHash(original)
  const s = seed?.trim() || null
  pieces.set(id, { original, seed: s, seedMeaning: s ? null : 1, meaning: 1, meaningOf })
  const { error } = await supabase.from('nt_ai_pieces').upsert(
    { id, original, seed: s, seed_meaning: s ? null : 1, task: task ?? null, page_id: pageId ?? null, meaning: 1, meaning_of: meaningOf },
    { onConflict: 'id', ignoreDuplicates: true })
  if (error) console.warn('ai score: could not save piece', error.message)
  window.dispatchEvent(new Event(PIECE_EVENT))
}

/** Fetch the originals of these pieces. Pieces marked before scores existed start from their current text. */
export async function loadPieces(current: Map<string, string>): Promise<void> {
  const missing = [...current.keys()].filter(id => !pieces.has(id) && UUID.test(id))
  if (!missing.length) return
  const { data, error } = await supabase.from('nt_ai_pieces').select('id, original, seed, seed_meaning, meaning, meaning_of').in('id', missing)
  if (error) throw error
  for (const r of data ?? []) {
    pieces.set(r.id as string, {
      original: r.original as string, seed: (r.seed as string | null) ?? null,
      seedMeaning: r.seed ? (r.seed_meaning as number | null) : 1,
      meaning: r.meaning as number | null, meaningOf: r.meaning_of as string | null,
    })
  }
  const unknown = missing.filter(id => !pieces.has(id))
  if (!unknown.length) return
  const rows = unknown.map(id => ({ id, original: current.get(id)!, seed_meaning: 1, meaning: 1, meaning_of: wordsHash(current.get(id)!) }))
  for (const r of rows) pieces.set(r.id, { original: r.original, seed: null, seedMeaning: 1, meaning: 1, meaningOf: r.meaning_of })
  const { error: e2 } = await supabase.from('nt_ai_pieces').upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
  if (e2) console.warn('ai score: could not save pieces', e2.message)
}

/** The score of piece `id` with its text now. `gemini`: include the meaning part. Null until its original is loaded. */
export function scoreFor(id: string, current: string, gemini: boolean): Score | null {
  const p = pieces.get(id)
  if (!p) return null
  const seedWords = p.seed ? words(p.seed) : null
  const w = wordShare(words(p.original), words(current), seedWords)
  const s = sentenceShare(p.original, current, p.seed)
  const h = wordsHash(current)
  // same words as the AI wrote: its meaning is all still there, no need to ask
  const same = h === wordsHash(p.original)
  const kept = !gemini ? null : same ? 1 : p.meaning
  const meaning = kept == null || p.seedMeaning == null ? null : kept * p.seedMeaning
  const stale = gemini && ((!same && p.meaningOf !== h) || p.seedMeaning == null)
  const ai = meaning == null ? (0.5 * w + 0.3 * s) / 0.8 : 0.5 * w + 0.3 * s + 0.2 * meaning
  return { ai, words: w, sentences: s, meaning, stale, rewritten: w === 0 && s === 0, seeded: !!p.seed }
}

/** Does piece `id` need a meaning check (of the AI's change to your text, or of your edits since)? */
export function meaningDue(id: string, current: string): boolean {
  const p = pieces.get(id)
  if (!p) return false
  const h = wordsHash(current)
  return p.seedMeaning == null || (h !== wordsHash(p.original) && p.meaningOf !== h)
}

// cosine similarity of two embeddings → how different the meaning is: unrelated texts sit around 0.7, close paraphrases above 0.95
const LOW = 0.7, HIGH = 0.95
const closeness = (similarity: number) => Math.min(1, Math.max(0, (similarity - LOW) / (HIGH - LOW)))

async function similarity(a: string, b: string): Promise<number | null> {
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { action: 'meaning', a, b } })
  if (error || typeof data?.similarity !== 'number') { console.warn('ai score: meaning check failed', error?.message ?? data); return null }
  return data.similarity as number
}

/** Ask Gemini what's due for piece `id` and store it. Quietly gives up (quota, offline). */
export async function checkMeaning(id: string, current: string): Promise<void> {
  const p = pieces.get(id)
  if (!p) return
  const patch: Record<string, unknown> = {}
  if (p.seedMeaning == null && p.seed) {
    const sim = await similarity(p.seed, p.original)
    if (sim == null) return
    p.seedMeaning = 1 - closeness(sim)
    patch.seed_meaning = p.seedMeaning
  }
  const h = wordsHash(current)
  if (h !== wordsHash(p.original) && p.meaningOf !== h) {
    const sim = await similarity(p.original, current)
    if (sim != null) {
      p.meaning = closeness(sim)
      p.meaningOf = h
      Object.assign(patch, { meaning: p.meaning, meaning_of: h })
    }
  }
  if (!Object.keys(patch).length) return
  const { error } = await supabase.from('nt_ai_pieces').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) console.warn('ai score: could not save meaning', error.message)
}
