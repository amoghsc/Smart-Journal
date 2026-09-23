import { strToU8, zipSync } from 'fflate'
import type { Page, Vault } from './types'
import { supabase } from './supabase'
import { isDailyTitle, normTitle, prettyDate } from './links'
import { plainText } from './html'
import { READER_CSS, READER_JS, readerHomePage, readerNotePage, readerSearchIndex, type ReaderCtx } from './reader'

/**
 * Turns a vault into a static site: plain HTML, no JavaScript, relative links
 * throughout so the output works at a domain root or in any subfolder.
 */

export interface SitePage {
  page: Page
  /** Published path, e.g. "notes/my-idea" or "journal/2026-09-22". */
  path: string
  slug: string
  daily: boolean
}

export interface SitePlan {
  /** Notes that will be published, in publication order. */
  included: SitePage[]
  /** Notes held back, with the reason. */
  skipped: { page: Page; reason: string }[]
  /** Titles linked to from published notes that will render as plain text. */
  unresolved: string[]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function slugFor(title: string): string {
  const s = title.toLowerCase().normalize('NFKD')
    .replace(/([a-z])\p{M}+/gu, '$1')          // café → cafe, but keep marks that other scripts need (मराठी)
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 120).replace(/-$/, '')
  return s || 'note'
}

/** Decide what goes out, before anything is generated, so the user can review it. */
export function planSite(pages: Page[]): SitePlan {
  const included: SitePage[] = []
  const skipped: { page: Page; reason: string }[] = []
  const used = new Set<string>()

  const candidates = [...pages].sort((a, b) => {
    const ad = isDailyTitle(a.title), bd = isDailyTitle(b.title)
    if (ad && bd) return b.title.localeCompare(a.title)   // newest day first
    if (ad !== bd) return ad ? -1 : 1
    return a.title.localeCompare(b.title)
  })

  for (const page of candidates) {
    if (page.kind === 'canvas') { skipped.push({ page, reason: 'canvas' }); continue }
    if (page.draft) { skipped.push({ page, reason: 'marked draft' }); continue }
    if (!plainText(page.body, 0).trim()) { skipped.push({ page, reason: 'empty' }); continue }

    const daily = isDailyTitle(page.title)
    let slug = daily ? page.title : slugFor(page.title)
    if (used.has(slug)) { let n = 2; while (used.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}` }
    used.add(slug)
    included.push({ page, slug, daily, path: `${daily ? 'journal' : 'notes'}/${slug}` })
  }

  const byTitle = new Map(included.map(s => [normTitle(s.page.title), s]))
  const unresolved = new Set<string>()
  for (const s of included) {
    for (const el of parse(s.page.body).querySelectorAll('a.wikilink')) {
      const t = el.getAttribute('data-title') ?? ''
      if (t && !byTitle.has(normTitle(t))) unresolved.add(t)
    }
  }
  return { included, skipped, unresolved: [...unresolved].sort() }
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body

/** Note body → publishable HTML: comments removed, links resolved or flattened. */
function renderBody(html: string, byTitle: Map<string, SitePage>, prefix: string): string {
  const body = parse(html)

  // private annotations never leave the app
  for (const el of [...body.querySelectorAll('[data-comment-id]')]) el.replaceWith(...el.childNodes)

  for (const el of [...body.querySelectorAll('a.wikilink')]) {
    const title = el.getAttribute('data-title') ?? el.textContent ?? ''
    const target = byTitle.get(normTitle(title))
    if (target) {
      const a = document.createElement('a')
      a.setAttribute('href', `${prefix}${target.path}/`)
      a.className = 'wikilink'
      a.textContent = el.textContent
      el.replaceWith(a)
    } else {
      // a link to something unpublished becomes plain text: no broken link, no leaked title
      el.replaceWith(document.createTextNode(el.textContent ?? ''))
    }
  }

  for (const el of [...body.querySelectorAll('a[href]')]) {
    const href = el.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener') }
  }

  for (const el of [...body.querySelectorAll('script,style,iframe:not([src*="youtube"])')]) el.remove()
  return body.innerHTML
}

function feed(plan: SitePlan, site: Vault, byTitle: Map<string, SitePage>): string {
  const base = (site.site_url || '').replace(/\/$/, '')
  const entries = plan.included.filter(s => s.daily).slice(0, 50)
  const items = entries.map(s => `  <item>
    <title>${esc(prettyDate(s.page.title))}</title>
    <link>${esc(base)}/${s.path}/</link>
    <guid isPermaLink="true">${esc(base)}/${s.path}/</guid>
    <pubDate>${new Date(s.page.created_at).toUTCString()}</pubDate>
    <description>${esc(renderBody(s.page.body, byTitle, base + '/'))}</description>
  </item>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(site.site_title || site.name)}</title>
  <link>${esc(base)}/</link>
  <description>${esc(site.site_description ?? '')}</description>
${items}
</channel></rss>
`
}

const README = (site: string) => `# ${site}

A static site exported from Smart Journal. Plain HTML — no build step, no JavaScript.

## Publishing it

**Any web host / cPanel / FTP:** upload the contents of this folder (not the folder
itself) into your web root, or into a subfolder such as /notes. Relative links mean
it works either way.

**Netlify:** drag this folder onto https://app.netlify.com/drop

**GitHub Pages:** commit these files to a repository, then Settings → Pages →
Deploy from a branch.

**Cloudflare Pages:** Create project → Direct upload → drop this folder.

Re-exporting replaces the files; upload again to update the site.
`

/** Full site as a map of path → file text. */
export function buildSite(plan: SitePlan, vault: Vault): Record<string, string> {
  const byTitle = new Map(plan.included.map(s => [normTitle(s.page.title), s]))

  // backlinks among published notes only
  const back = new Map<string, SitePage[]>()
  for (const s of plan.included) {
    for (const el of parse(s.page.body).querySelectorAll('a.wikilink')) {
      const target = byTitle.get(normTitle(el.getAttribute('data-title') ?? ''))
      if (!target || target.page.id === s.page.id) continue
      const list = back.get(target.page.id) ?? []
      if (!list.some(x => x.page.id === s.page.id)) back.set(target.page.id, [...list, s])
    }
  }

  // rendered bodies, and their plain text (from the DOM, so comment bodies held in attributes never leak into excerpts)
  const bodies = new Map(plan.included.map(s => [s.page.id, renderBody(s.page.body, byTitle, '../../')]))
  const text = new Map([...bodies].map(([id, html]) => [id, (parse(html).textContent ?? '').replace(/\s+/g, ' ').trim()]))
  const ctx: ReaderCtx = { site: vault, plan, text, backlinks: back }

  const files: Record<string, string> = {
    'index.html': readerHomePage(ctx),
    'style.css': READER_CSS,
    'script.js': READER_JS,
    'search.json': readerSearchIndex(ctx),
    '.nojekyll': '',
    'README.md': README(vault.site_title || vault.name),
  }
  for (const s of plan.included) files[`${s.path}/index.html`] = readerNotePage(s, bodies.get(s.page.id)!, ctx)
  if (vault.site_url) files['feed.xml'] = feed(plan, vault, byTitle)
  return files
}

export interface GitHubStatus { configured: boolean; repo: string | null; branch: string; siteUrl: string | null }
export interface GitHubResult { commit: string; unchanged: boolean; repo: string; siteUrl: string; commitUrl: string }

/** Errors from the function carry a JSON body with a readable message. */
async function fnError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try { const b = await ctx.json(); if (b?.error) return new Error(b.error) } catch { /* not JSON */ }
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** Is one-click publishing set up (token + repo held by the server)? Never returns the token. */
export async function githubStatus(): Promise<GitHubStatus> {
  const { data, error } = await supabase.functions.invoke('nt-publish', { body: { action: 'status' } })
  if (error) throw await fnError(error)
  return data as GitHubStatus
}

/** Send the built site to the server, which commits it to the configured repo. The browser never sees the token. */
export async function publishToGitHub(plan: SitePlan, vault: Vault): Promise<GitHubResult> {
  const files = buildSite(plan, vault)
  const { data, error } = await supabase.functions.invoke('nt-publish', { body: { vault_id: vault.id, files } })
  if (error) throw await fnError(error)
  return data as GitHubResult
}

/** Build the site and hand the browser a .zip download. */
export function downloadSite(plan: SitePlan, vault: Vault): number {
  const text = buildSite(plan, vault)
  const files = Object.fromEntries(Object.entries(text).map(([k, v]) => [k, strToU8(v)]))
  const zip = zipSync(files, { level: 6 })
  const blob = new Blob([zip as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slugFor(vault.site_title || vault.name)}-${new Date().toISOString().slice(0, 10)}.zip`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return Object.keys(files).length
}
