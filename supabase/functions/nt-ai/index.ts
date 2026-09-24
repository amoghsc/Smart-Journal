// AI writing tools for Smart Journal, backed by Gemini.
//
//  - The Gemini key lives only in this function's secrets (GEMINI_API_KEY); the browser never sees it.
//  - Only signed-in members can call it (checked through RLS with the caller's JWT).
//  - The model sees only the text the user selected — no search grounding, no tools, no other notes.
//
// Secrets: GEMINI_API_KEY; optional GEMINI_MODEL (default gemini-3.6-flash) and GEMINI_FALLBACKS
// (comma-separated, tried in order when the main model is overloaded or rate-limited).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://amoghsc.github.io', 'http://localhost:5183']
const MAX_CHARS = 40_000

const TASKS: Record<string, string> = {
  summarise:
    'You summarise a passage from the user\'s own notes. Use only the passage: add no facts, opinions or advice that are not in it. ' +
    'Keep the author\'s voice and point of view, and write in the same language as the passage (Marathi stays Marathi, Hindi stays Hindi). ' +
    'Aim for roughly a quarter of the original length, keeping names, decisions, dates and commitments. ' +
    'Write plain text: short paragraphs, or lines starting with "- " if the passage is itself a list. ' +
    'No headings, no bold or other markdown, no preamble such as "Here is a summary".',
}

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

async function gemini(key: string, models: string[], system: string, text: string): Promise<{ text: string; model: string }> {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
  }
  let last = ''
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const data = await res.json()
      const out = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('').trim()
      if (!out) throw new HttpError(502, data?.promptFeedback?.blockReason ? 'Gemini declined this text' : 'Gemini returned nothing')
      return { text: out, model }
    }
    last = `${res.status} ${(await res.text()).slice(0, 200)}`
    if ((res.status === 429 || res.status === 503 || res.status === 404) && i < models.length - 1) continue
    if (res.status === 429) throw new HttpError(429, 'The free Gemini quota is used up for now — try again in a minute')
    if (res.status === 400 || res.status === 403) throw new HttpError(502, 'Gemini rejected the request — check the API key')
    break
  }
  throw new HttpError(502, `Gemini is unavailable right now (${last.split(' ')[0]})`)
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

    const system = TASKS[body.task]
    if (!system) throw new HttpError(400, 'Unknown task')
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new HttpError(400, 'Select some text first')
    if (text.length > MAX_CHARS) throw new HttpError(413, 'That selection is too long — pick a shorter passage')

    const main = Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash'
    const fallbacks = (Deno.env.get('GEMINI_FALLBACKS') || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean)
    const result = await gemini(geminiKey, [main, ...fallbacks.filter(m => m !== main)], system, text)
    return json(200, result)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    console.error('nt-ai', status, (e as Error).message)
    return json(status, { error: (e as Error).message })
  }
})
