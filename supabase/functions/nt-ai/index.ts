// AI writing tools for Smart Journal, backed by Gemini.
//
//  - The Gemini key lives only in this function's secrets (GEMINI_API_KEY); the browser never sees it.
//  - Only signed-in members can call it (checked through RLS with the caller's JWT).
//  - The model sees only the text the user selected — no search grounding, no tools, no other notes.
//    (The AI score's meaning check sends one AI-written piece: as written, and as it reads after your edits.)
//
// Secrets: GEMINI_API_KEY; optional GEMINI_MODEL (default gemini-3.6-flash) and GEMINI_FALLBACKS
// (comma-separated, tried in order when the main model is overloaded or rate-limited); optional GEMINI_EMBED_MODEL
// (default gemini-embedding-001) for the AI score.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://amoghsc.github.io', 'http://localhost:5183']
const MAX_CHARS = 40_000

// Shared by every task. The text arrives with light markup that must survive the rewrite.
const COMMON =
  ' The passage is from the user\'s own notes. ' +
  'Unless the task asks for a particular tone or style, use simple, clear language and a neutral tone. ' +
  'The passage may contain markup: lines starting with "- " are bullets and "1. " numbered items, indented two spaces per nesting level ' +
  '(keep them as lists, with the same nesting, when the result is a list), ' +
  '[[Title]] is a link to another note and [words](https://…) a link to a website — keep every such link exactly as written, including the brackets. ' +
  'Output only the resulting text: plain text with blank lines between paragraphs, no headings, no bold or italics, no quotation marks around it, ' +
  'and no preamble or comment such as "Here is…".'

const LANG_NAMES: Record<string, string> = { en: 'English', mr: 'Marathi', hi: 'Hindi' }

/**
 * The result stays in the passage's language. The app works out which language most of the passage is in
 * (`lang`); for Marathi and Hindi it says so, since the two share a script and mixed text can pull the model
 * towards English. Latin script gets no hint: it may be romanised Hindi or Marathi, which should stay that way.
 */
function languageRule(lang: unknown): string {
  const name = lang === 'mr' || lang === 'hi' ? LANG_NAMES[lang] : null
  return ' Write the result in the same language and script as the passage. If the passage mixes languages, write the whole result in the one ' +
    'that makes up most of it, keeping a word from the other only where the author would naturally use it (a name or a common loanword).' +
    (name ? ` Most of this passage is ${name}, so write in ${name}, in Devanagari script.` : '')
}

const TASKS: Record<string, string> = {
  grammar:
    'Correct spelling, grammar and punctuation. Change nothing else: keep the wording, tone, structure and length. ' +
    'If the passage is already correct, return it unchanged.',
  shorten:
    'Make the passage shorter — about half its length — by tightening sentences and removing repetition and filler. ' +
    'Keep every point, the author\'s voice and first person, and the structure. This is a tighter version of the same text, not a summary about it.',
  summarise:
    'Summarise the passage. Use only the passage: add no facts, opinions or advice that are not in it. ' +
    'Keep the author\'s voice and point of view. Aim for roughly a quarter of the original length, keeping names, decisions, dates and commitments. ' +
    'Use short paragraphs, or "- " lines if the passage is itself a list.',
  expand:
    'Expand the passage to about twice its length by developing the ideas already in it: explain the reasoning, add texture and connecting sentences. ' +
    'Keep the author\'s voice and first person. Do not invent specific facts about the author\'s life — no new names, events, places or numbers.',
  formal:
    'Rewrite the passage in a formal tone: polished, precise and professional — no slang, contractions or casual asides. ' +
    'Keep the meaning, every point and the author\'s first person.',
  friendly:
    'Rewrite the passage in a warm, friendly tone — approachable and kind, as if talking to a friend you respect. ' +
    'Keep the meaning, every point and the author\'s first person.',
  casual:
    'Rewrite the passage in a casual, relaxed tone — everyday phrasing and contractions, like chatting. ' +
    'Keep the meaning, every point and the author\'s first person.',
  genz:
    'Rewrite the passage the way someone from Gen Z would say it — current internet slang and phrasing used naturally, not overdone, ' +
    'with at most a couple of emojis. In Marathi or Hindi, use the young, everyday register of that language. ' +
    'Keep the meaning, every point and the author\'s first person.',
  simpler:
    'Rewrite the passage in simpler language: short sentences, everyday words, no jargon, readable by a 12-year-old. ' +
    'Keep the meaning, every point and the author\'s first person.',
  funny:
    'Rewrite the passage to be funny — playful, witty, light — while keeping its meaning and every point. ' +
    'Keep the author\'s first person. Gentle humour only: no mean, crude or offensive jokes.',
  emotional:
    'Rewrite the passage to be more emotional: bring out the feelings behind it with vivid, heartfelt language. ' +
    'Keep the meaning, the facts and the author\'s first person. Do not invent events or people.',
  sarcastic:
    'Rewrite the passage with a sarcastic, dry, tongue-in-cheek tone — irony and understatement that make the point land — while keeping its meaning and every point. ' +
    'Keep the author\'s first person. Aim the sarcasm at the situation, never mean or insulting towards people.',
  translate:
    'Translate the passage into {target}. Make it read naturally, the way a fluent native speaker would write it — not word for word — keeping the meaning, ' +
    'tone, every point, the structure and the author\'s first person. Keep names as they are, written in the target script where that is natural.',
  story:
    'Write a short story (about 150 to 250 words, 2 to 4 short paragraphs) that illustrates the key points of the passage: a concrete character and a small, ' +
    'everyday situation that make the ideas vivid, so the point lands without a lecture. It is an illustration — do not present it as something that happened ' +
    'to the author, do not retell the passage, and do not add a moral at the end.',
  structure:
    'Suggest a structure for a section about what the passage covers: 5 to 7 "- " lines in a sensible order, each naming one point the section should cover ' +
    '— a few words, optionally followed by " — " and a one-line note on what to say. Build on the passage; do not rewrite it.',
  forAgainst:
    'Weigh the argument the passage makes. Output two parts separated by a blank line. Part one: a line with just the word "For" (in the passage\'s language), ' +
    'then 2 to 5 "- " lines, each one point supporting the argument. Part two: a line with just the word "Against" (in the passage\'s language), then 2 to 5 "- " lines, ' +
    'each one point opposing it. One or two sentences per point; be fair to both sides; add no facts about the author\'s life.',
  synonyms:
    'The input gives one word and the sentence it appears in. List up to 8 words or short phrases with a similar meaning that would fit in its place in that sentence, ' +
    'in the same language and script as the word, matching its form (tense, number, gender, case). Most natural first. ' +
    'Output one per line and nothing else — no numbering, bullets, explanations or the original word.',
  elaborate:
    'Elaborate on the concept in the passage for a reader meeting it for the first time. Write a few sentences (about 4 to 7) that explain it more fully ' +
    'and approach it from a couple of different angles: what it means in plain words, why it matters, and a concrete everyday example. ' +
    'Stay faithful to the passage — do not contradict it or add claims about the author\'s life. Write an explanation, not a rewrite of the passage.',
  metaphors:
    'Give 3 metaphors or analogies that explain the main idea of the passage better, each drawn from everyday life. ' +
    'Output only the list: one "- " line per metaphor, one or two sentences each. Do not repeat or rewrite the passage.',
}

const WORD_TASKS = new Set(['synonyms'])

// how adventurous the wording may be: cautious for corrections, freer for creative rewrites
const TEMPERATURE: Record<string, number> = { sarcastic: 0.9, translate: 0.2, story: 0.9, structure: 0.5, forAgainst: 0.6, formal: 0.3, friendly: 0.6, casual: 0.6, genz: 0.8, elaborate: 0.7, synonyms: 0.5, grammar: 0.1, shorten: 0.3, summarise: 0.3, expand: 0.6, simpler: 0.4, funny: 0.9, emotional: 0.8, metaphors: 0.9 }

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

/** Google's own reason from an error body (it never echoes the user's text). */
function googleMessage(raw: string): string {
  try { const m = JSON.parse(raw)?.error?.message; if (typeof m === 'string') return m.slice(0, 240) } catch { /* not JSON */ }
  return raw.slice(0, 240)
}

/**
 * One generateContent call with fallbacks. A model that rejects the request (400) is retried once without the
 * thinking setting — some models refuse to have thinking turned off — before moving on to the next model.
 */
async function gemini(key: string, models: string[], system: string, text: string, temperature: number): Promise<{ text: string; model: string }> {
  const request = (thinkingOff: boolean) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: thinkingOff ? { temperature, thinkingConfig: { thinkingBudget: 0 } } : { temperature },
  })
  let lastStatus = 0, lastMessage = ''
  for (const model of models) {
    for (const thinkingOff of [true, false]) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(request(thinkingOff)),
      })
      if (res.ok) {
        const data = await res.json()
        const out = (data?.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought)
          .map((p: { text?: string }) => p.text ?? '').join('').trim()
        if (!out) throw new HttpError(502, data?.promptFeedback?.blockReason ? 'Gemini declined this text' : 'Gemini returned nothing')
        return { text: out, model }
      }
      lastStatus = res.status
      lastMessage = googleMessage(await res.text())
      console.error('nt-ai gemini', model, thinkingOff ? 'thinking-off' : 'default', res.status, lastMessage)
      // a bad or restricted key fails the same way on every model
      if (/api key|API_KEY/i.test(lastMessage)) throw new HttpError(502, `Gemini rejected the API key: ${lastMessage}`)
      if (res.status !== 400 || !thinkingOff) break
    }
  }
  if (lastStatus === 429) throw new HttpError(429, 'The free Gemini quota is used up for now — try again in a minute')
  throw new HttpError(502, `Gemini couldn’t do this (${lastStatus}): ${lastMessage}`)
}

/**
 * How close two texts are in meaning: the cosine similarity of their Gemini embeddings (about 0.7 for unrelated
 * text, above 0.95 for close paraphrases). Used for the meaning part of the AI score.
 */
async function similarity(key: string, a: string, b: string): Promise<number> {
  const model = Deno.env.get('GEMINI_EMBED_MODEL') || 'gemini-embedding-001'
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ requests: [a, b].map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY' })) }),
  })
  if (!res.ok) {
    const message = googleMessage(await res.text())
    console.error('nt-ai embed', model, res.status, message)
    if (res.status === 429) throw new HttpError(429, 'The free Gemini quota is used up for now — try again in a minute')
    throw new HttpError(502, `Gemini couldn’t compare the texts (${res.status}): ${message}`)
  }
  const data = await res.json()
  const [x, y] = (data?.embeddings ?? []).map((e: { values?: number[] }) => e.values ?? [])
  if (!x?.length || x.length !== y?.length) throw new HttpError(502, 'Gemini returned no embeddings')
  let dot = 0, nx = 0, ny = 0
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i] }
  return dot / (Math.sqrt(nx * ny) || 1)
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only')
    const auth = req.headers.get('Authorization')
    if (!auth) throw new HttpError(401, 'Sign in first')

    const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!key) throw new HttpError(500, 'Function is missing its Supabase key')
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const { data: member, error: memberErr } = await sb.rpc('nt_is_member')
    if (memberErr) throw new HttpError(500, `Membership check failed: ${memberErr.message}`)
    if (member !== true) throw new HttpError(403, 'Not allowed')

    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    const body = await req.json().catch(() => ({}))
    if (body.action === 'status') return json(200, { configured: !!geminiKey, tasks: Object.keys(TASKS) })
    if (!geminiKey) throw new HttpError(412, 'AI isn’t set up yet')

    // AI score: how close an edited piece still is in meaning to what the AI wrote
    if (body.action === 'meaning') {
      const a = typeof body.a === 'string' ? body.a.trim() : '', b = typeof body.b === 'string' ? body.b.trim() : ''
      if (!a || !b) throw new HttpError(400, 'Two texts are needed')
      if (a.length > MAX_CHARS || b.length > MAX_CHARS) throw new HttpError(413, 'Text too long to compare')
      return json(200, { similarity: await similarity(geminiKey, a, b) })
    }

    // word-level tasks have their own output format; the shared rules are for rewriting passages
    const prompt = Object.hasOwn(TASKS, body.task) ? TASKS[body.task] : undefined
    if (!prompt) throw new HttpError(400, 'Unknown task')
    let system: string
    if (body.task === 'translate') {
      const target = Object.hasOwn(LANG_NAMES, body.target) ? LANG_NAMES[body.target] : null
      if (!target) throw new HttpError(400, 'Pick a language to translate into')
      system = prompt.replace('{target}', target) + COMMON + ` Write the whole result in ${target}${target === 'English' ? '' : ', in Devanagari script'}.`
    } else {
      system = WORD_TASKS.has(body.task) ? prompt : prompt + COMMON + languageRule(body.lang)
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new HttpError(400, 'Select some text first')
    if (text.length > MAX_CHARS) throw new HttpError(413, 'That selection is too long — pick a shorter passage')

    const main = Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash'
    const models = [main, ...(Deno.env.get('GEMINI_FALLBACKS') || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(m => m && m !== main)]
    const temperature = TEMPERATURE[body.task] ?? 0.4

    // Two versions to choose from: run twice in parallel, the second a little more adventurous.
    // Duplicates are dropped; if one call fails the other still counts.
    const variants = body.variants === 2 && !WORD_TASKS.has(body.task) ? 2 : 1
    const temps = variants === 2 ? [temperature, Math.min(1.3, temperature + 0.35)] : [temperature]
    const settled = await Promise.allSettled(temps.map(t => gemini(geminiKey, models, system, text, t)))
    const ok = settled.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
    if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const texts = ok.map(r => r.text).filter((t, i, all) => all.findIndex(o => norm(o) === norm(t)) === i)
    return json(200, { text: texts[0], texts, model: ok[0].model })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    console.error('nt-ai', status, (e as Error).message)
    return json(status, { error: (e as Error).message })
  }
})
