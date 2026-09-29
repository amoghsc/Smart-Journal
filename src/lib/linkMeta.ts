import { supabase } from './supabase'
import type { LinkTitleStyle } from './settings'

/** A web page's own details, as the nt-link function found them (no AI). */
export interface LinkMeta { ok: boolean; title?: string | null; author?: string | null; published?: string | null; site?: string | null }

// asked for together: links pasted at once go in one request; each address is asked about once per session
const known = new Map<string, Promise<LinkMeta>>()
let waiting: { url: string; resolve: (m: LinkMeta) => void }[] = []
let timer = 0

async function send(batch: typeof waiting, refresh: boolean) {
  for (let i = 0; i < batch.length; i += 20) {
    const part = batch.slice(i, i + 20)
    try {
      const { data, error } = await supabase.functions.invoke('nt-link', { body: { urls: part.map(w => w.url), refresh } })
      if (error) throw error
      const results = (data?.results ?? {}) as Record<string, LinkMeta>
      part.forEach(w => w.resolve(results[w.url] ?? { ok: false }))
    } catch (e) {
      console.warn('link titles: lookup failed', e)
      part.forEach(w => { known.delete(w.url); w.resolve({ ok: false }) })
    }
  }
}

/** The details of the page at `url` (`refresh`: look again rather than use what's remembered). */
export function linkMeta(url: string, refresh = false): Promise<LinkMeta> {
  if (refresh) { const p = new Promise<LinkMeta>(resolve => send([{ url, resolve }], true)); known.set(url, p); return p }
  let p = known.get(url)
  if (!p) {
    p = new Promise<LinkMeta>(resolve => {
      waiting.push({ url, resolve })
      clearTimeout(timer)
      timer = window.setTimeout(() => { const batch = waiting; waiting = []; send(batch, false) }, 60)
    })
    known.set(url, p)
  }
  return p
}

/** The time a link starts at (YouTube's t=4403, t=1h13m23s, #t=…, start=…) as "1:13:23", or null. */
export function timeIn(href: string): string | null {
  let u: URL
  try { u = new URL(href) } catch { return null }
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? u.searchParams.get('time_continue') ?? u.hash.match(/[#&]t=([^&]+)/)?.[1]
  if (!raw) return null
  let s = 0
  if (/^\d+s?$/.test(raw)) s = parseInt(raw, 10)
  else {
    const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
    if (!m || !m[0]) return null
    s = (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0))
  }
  if (!s) return null
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`
}

/** What the link should say, e.g. "Title — Author · at 1:13:23 · 12 Jan 2026"; null when the page gave no title. */
export function linkLabel(href: string, m: LinkMeta, style: LinkTitleStyle): string | null {
  if (!m.ok || !m.title || style === 'off') return null
  let s = m.title
  if (style !== 'title' && m.author && !s.toLowerCase().includes(m.author.toLowerCase())) s += ` — ${m.author}`
  const t = timeIn(href)
  if (t) s += ` · at ${t}`
  if (style === 'full' && m.published) {
    const d = new Date(`${m.published}T00:00:00`)
    if (!Number.isNaN(d.getTime())) s += ` · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  }
  return s
}

const bareOf = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
/** The link shows its own address (as pasted or typed), not words of its own. */
export const isBareLink = (text: string, href: string) => !!text.trim() && bareOf(text) === bareOf(href)
/** The link's words are no title at all: leftovers like <!---->, only a timestamp or symbols, or its bare address. */
export function isJunkLinkText(text: string, href: string): boolean {
  const t = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  return !t || isBareLink(t, href) || !/\p{L}{2,}/u.test(t)
}
