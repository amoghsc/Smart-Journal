// Link titles for Smart Journal: the title, author and date of web pages people link to. No AI — each page's own
// details: YouTube/Vimeo/Spotify/SoundCloud/X through their public oEmbed lookups, anything else from the tags in
// the page's <head> (Open Graph, meta author/date, schema.org JSON-LD).
//
//  - Only signed-in members can call it (checked through RLS with the caller's JWT), at most RATE urls a minute.
//  - It only fetches public http(s) pages: never an address on a private/internal network (checked after DNS, on
//    every redirect), at most 4 redirects, 6 s, and the first 600 KB of a page.
//  - Results are remembered for 30 days (a day for pages that couldn't be read), keyed by a hash of the address.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://amoghsc.github.io', 'http://localhost:5183']
const MAX_URLS = 20
const RATE = 120            // urls a person may look up per minute
const TIMEOUT_MS = 6000
const MAX_BYTES = 600_000
const FRESH_DAYS = 30
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

interface Meta { ok: boolean; title?: string | null; author?: string | null; published?: string | null; site?: string | null }

class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// ---- safety: public addresses only ----

function privateV4(ip: string) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true
  const [a, b] = p
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
}
function privateV6(ip: string) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true
  const v4 = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) return privateV4(v4[1])
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s)
}
async function publicUrl(raw: string): Promise<URL> {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error('not an address') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not a web address')
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('unusual port')
  if (u.username || u.password) throw new Error('credentials in address')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host)) throw new Error('private address')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) { if (privateV4(host)) throw new Error('private address'); return u }
  if (host.includes(':')) { if (privateV6(host)) throw new Error('private address'); return u }
  // if this runtime can't look names up, the checks above (and on every redirect) still apply
  let dnsDown = false
  const look = async (t: 'A' | 'AAAA'): Promise<string[]> => {
    try { return await Deno.resolveDns(host, t) } catch (e) { if (!(e instanceof Deno.errors.NotFound)) dnsDown = true; return [] }
  }
  const [a, aaaa] = await Promise.all([look('A'), look('AAAA')])
  if (!a.length && !aaaa.length && !dnsDown) throw new Error('unknown host')
  if (a.some(privateV4) || aaaa.some(privateV6)) throw new Error('private address')
  return u
}

/**
 * Fetch a public page (redirects followed by hand, each hop checked), reading at most `max` bytes of it — and only
 * up to `stop` (default: the end of <head>, where the details are).
 */
async function fetchPublic(raw: string, accept = 'text/html,application/xhtml+xml', max = MAX_BYTES, stop: RegExp = /<\/head>/i): Promise<{ url: string; status: number; type: string; body: string }> {
  let url = raw
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    for (let hop = 0; hop < 5; hop++) {
      const u = await publicUrl(url)
      const res = await fetch(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-GB,en;q=0.9' } })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, u).href
        await res.body?.cancel()
        continue
      }
      const type = res.headers.get('content-type') ?? ''
      let body = ''
      if (res.body && /html|json|xml|text/i.test(type)) {
        const reader = res.body.getReader(), dec = new TextDecoder()
        let n = 0
        while (n < max) {
          const { done, value } = await reader.read()
          if (done) break
          n += value.length
          body += dec.decode(value, { stream: true })
          if (/html/i.test(type) && stop.test(body.slice(-value.length - 200))) break
        }
        await reader.cancel().catch(() => {})
      } else await res.body?.cancel()
      return { url, status: res.status, type, body }
    }
    throw new Error('too many redirects')
  } finally { clearTimeout(timer) }
}

// ---- reading the details ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·' }
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
const tidy = (s: string | null | undefined, max = 300) => (s ? decode(s).replace(/\s+/g, ' ').trim().slice(0, max) || null : null)

/** A date in any usual form → YYYY-MM-DD (only if it's a real, not-future date). */
function day(s: string | null | undefined): string | null {
  if (!s) return null
  const t = Date.parse(s.trim())
  if (Number.isNaN(t) || t > Date.now() + 2 * 86400_000 || t < Date.UTC(1990, 0, 1)) return null
  return new Date(t).toISOString().slice(0, 10)
}

function metaTags(head: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
    const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1]
    if (key && content != null && !out.has(key)) out.set(key, content)
  }
  return out
}

/** schema.org details (Article, VideoObject…) from JSON-LD blocks. */
function jsonLd(html: string): { headline?: string; author?: string; date?: string } {
  const found: { headline?: string; author?: string; date?: string } = {}
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown
    try { data = JSON.parse(m[1].trim()) } catch { continue }
    const nodes: Record<string, unknown>[] = []
    const collect = (d: unknown) => {
      if (Array.isArray(d)) d.forEach(collect)
      else if (d && typeof d === 'object') { nodes.push(d as Record<string, unknown>); if ((d as Record<string, unknown>)['@graph']) collect((d as Record<string, unknown>)['@graph']) }
    }
    collect(data)
    for (const n of nodes) {
      const type = String(n['@type'] ?? '')
      if (!/Article|Posting|Video|Blog|Report|Review|Podcast|Episode|Recipe|Book|WebPage/i.test(type)) continue
      const name = (a: unknown): string | undefined => {
        if (!a) return undefined
        if (typeof a === 'string') return /^https?:/.test(a) ? undefined : a
        if (Array.isArray(a)) return a.map(name).filter(Boolean).slice(0, 3).join(', ') || undefined
        if (typeof a === 'object') return name((a as Record<string, unknown>).name)
        return undefined
      }
      found.headline ??= typeof n.headline === 'string' ? n.headline : typeof n.name === 'string' && !/WebPage/i.test(type) ? n.name : undefined
      found.author ??= name(n.author) ?? name(n.creator)
      found.date ??= typeof n.datePublished === 'string' ? n.datePublished : typeof n.uploadDate === 'string' ? n.uploadDate : undefined
    }
  }
  return found
}

// a page that isn't the page: a sign-in wall, a bot check, an error
const WALL = /^(sign ?in|log ?in|login|sign up|access denied|just a moment|attention required|are you a robot|captcha|403|404|not found|page not found|error|forbidden|subscribe to continue|redirecting|client challenge|security check|checking your browser|verifying|human verification|one moment)\b|\b(sign in to|log in to|log into)\b|– sign in$|^instagram$|^linkedin$|^facebook$|^x$|^spotify – web player$|^youtube$/i

function fromHtml(html: string, finalUrl: string): Meta {
  const head = html.split(/<\/head>/i)[0]
  const m = metaTags(head)
  const ld = jsonLd(html)
  const site = tidy(m.get('og:site_name')) ?? new URL(finalUrl).hostname.replace(/^www\./, '')
  let title = tidy(m.get('og:title')) ?? tidy(m.get('twitter:title')) ?? tidy(ld.headline) ?? tidy(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  if (title) {
    // "Story title | The Paper", "Antifragility - Wikipedia" → the story's own title
    const cut = title.match(/^(.*\S)\s+[|\-–—·:]\s+([^|\-–—·:]{2,40})$/)
    const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
    const host = squash(new URL(finalUrl).hostname.replace(/^www\./, ''))
    const brand = (x: string) => squash(x) === squash(site) || host.includes(squash(x))
    if (cut && cut[1].length > 3 && brand(cut[2])) title = cut[1]
    // "GitHub - owner/repo: …" → "owner/repo: …"
    const lead = title.match(/^([^|\-–—·:]{2,40}?)\s+[|\-–—·]\s+(.{4,})$/)
    if (lead && brand(lead[1])) title = lead[2]
  }
  if (!title || WALL.test(title)) return { ok: false, site }
  const authorTag = tidy(m.get('author')) ?? tidy(m.get('article:author')) ?? tidy(m.get('parsely-author')) ?? tidy(m.get('byl')) ?? tidy(m.get('twitter:creator')) ?? tidy(m.get('sailthru.author'))
  const author = tidy(ld.author) ?? (authorTag && !/^https?:/.test(authorTag) ? authorTag.replace(/^by\s+/i, '') : null)
  const published = day(m.get('article:published_time')) ?? day(ld.date) ?? day(m.get('datepublished')) ?? day(m.get('uploaddate')) ?? day(m.get('publish-date')) ??
    day(m.get('pubdate')) ?? day(m.get('date')) ?? day(m.get('dc.date')) ?? day(m.get('og:published_time')) ?? day(html.match(/<time[^>]+datetime="([^"]+)"/i)?.[1])
  return { ok: true, title, author, published, site }
}

async function oembed(endpoint: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchPublic(endpoint, 'application/json')
    if (r.status !== 200) return null
    return JSON.parse(r.body)
  } catch { return null }
}

const isYouTube = (u: URL) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i.test(u.hostname)

async function lookUp(raw: string): Promise<Meta> {
  const u = new URL(raw)
  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  if (isYouTube(u)) {
    const o = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(raw)}`)
    if (!o?.title) return { ok: false, site: 'YouTube' }
    // the upload date is only on the video's own page
    let published: string | null = null
    try {
      // (it sits about 700 KB into the page)
      const page = await fetchPublic(raw, undefined, 1_200_000, /itemprop="uploadDate"[^>]*>/)
      published = day(page.body.match(/itemprop="(?:uploadDate|datePublished)"\s+content="([^"]+)"/)?.[1]) ?? day(page.body.match(/"(?:uploadDate|publishDate)":"([^"]+)"/)?.[1])
    } catch { /* title and channel are enough */ }
    return { ok: true, title: tidy(String(o.title)), author: tidy(String(o.author_name ?? '')), published, site: 'YouTube' }
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    const o = await oembed(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(raw)}`)
    if (o?.title) return { ok: true, title: tidy(String(o.title)), author: tidy(String(o.author_name ?? '')), published: day(String(o.upload_date ?? '')), site: 'Vimeo' }
  }
  if (host === 'open.spotify.com') {
    const o = await oembed(`https://open.spotify.com/oembed?url=${encodeURIComponent(raw)}`)
    if (o?.title) return { ok: true, title: tidy(String(o.title)), author: null, published: null, site: 'Spotify' }
  }
  if (host === 'soundcloud.com') {
    const o = await oembed(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(raw)}`)
    if (o?.title) return { ok: true, title: tidy(String(o.title)), author: tidy(String(o.author_name ?? '')), published: null, site: 'SoundCloud' }
  }
  if (/^(x|twitter|mobile\.twitter)\.com$/.test(host) && /\/status\//.test(u.pathname)) {
    const o = await oembed(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(raw.replace(/\/\/(www\.)?x\.com/, '//twitter.com'))}`)
    if (o?.html) {
      const html = String(o.html)
      const text = tidy(html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ''), 400) ?? ''
      const date = day(html.match(/<a[^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>\s*<\/blockquote>/)?.[1])
      const title = text.length > 90 ? text.slice(0, 88).replace(/\s+\S*$/, '') + '…' : text
      if (title) return { ok: true, title: `“${title}”`, author: tidy(String(o.author_name ?? '')), published: date, site: 'X' }
    }
    return { ok: false, site: 'X' }
  }
  const page = await fetchPublic(raw)
  if (page.status >= 400 || !/html/i.test(page.type)) return { ok: false, site: host }
  return fromHtml(page.body, page.url)
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only')
    const auth = req.headers.get('Authorization')
    if (!auth) throw new HttpError(401, 'Sign in first')
    const url = Deno.env.get('SUPABASE_URL')!
    const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const [{ data: member }, { data: who }] = await Promise.all([asUser.rpc('nt_is_member'), asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''))])
    if (member !== true || !who.user) throw new HttpError(403, 'Not allowed')
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

    const body = await req.json().catch(() => ({}))
    const urls: string[] = [...new Set((Array.isArray(body.urls) ? body.urls : []).filter((x: unknown): x is string => typeof x === 'string' && x.length < 2048))].slice(0, MAX_URLS)
    if (!urls.length) return json(200, { results: {} })
    const refresh = body.refresh === true

    const since = new Date(Date.now() - 60_000).toISOString()
    const { data: recent } = await admin.from('nt_link_calls').select('urls').eq('user_id', who.user.id).gte('at', since)
    if ((recent ?? []).reduce((n, r) => n + (r.urls as number), 0) + urls.length > RATE) throw new HttpError(429, 'Too many links at once — try again in a minute')
    await admin.from('nt_link_calls').insert({ user_id: who.user.id, urls: urls.length })

    const hashes = await Promise.all(urls.map(sha256))
    const cached = new Map<string, Meta & { fetched_at: string }>()
    if (!refresh) {
      const { data } = await admin.from('nt_link_meta').select('url_hash,ok,title,author,published,site,fetched_at').in('url_hash', hashes)
      for (const r of data ?? []) cached.set(r.url_hash as string, r as Meta & { fetched_at: string })
    }
    const results: Record<string, Meta> = {}
    const fresh: Record<string, unknown>[] = []
    await Promise.all(urls.map(async (u, i) => {
      const c = cached.get(hashes[i])
      const age = c ? Date.now() - Date.parse(c.fetched_at) : Infinity
      if (c && age < (c.ok ? FRESH_DAYS : 1) * 86400_000) { results[u] = { ok: c.ok, title: c.title, author: c.author, published: c.published, site: c.site }; return }
      let m: Meta
      try { m = await lookUp(u) } catch (e) { console.warn('nt-link', u.slice(0, 80), (e as Error).message); m = { ok: false } }
      results[u] = m
      fresh.push({ url_hash: hashes[i], ok: m.ok, title: m.title ?? null, author: m.author ?? null, published: m.published ?? null, site: m.site ?? null, fetched_at: new Date().toISOString() })
    }))
    if (fresh.length) { const { error } = await admin.from('nt_link_meta').upsert(fresh); if (error) console.warn('nt-link cache', error.message) }
    // old rate-limit rows go now and then
    if (Math.random() < 0.02) await admin.from('nt_link_calls').delete().lt('at', new Date(Date.now() - 3600_000).toISOString())
    return json(200, { results })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    console.error('nt-link', status, (e as Error).message)
    return json(status, { error: (e as Error).message })
  }
})
