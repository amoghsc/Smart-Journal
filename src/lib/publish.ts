import { strToU8, zipSync } from 'fflate'
import type { Page, Vault } from './types'
import { supabase } from './supabase'
import { isDailyTitle, normTitle, prettyDate } from './links'
import { plainText } from './html'
import { READER_CSS, READER_JS, readerHomePage, readerLanding, readerNotePage, readerSearchIndex, type LandingVault, type ReaderCtx } from './reader'

/**
 * Turns a vault into a static site: plain HTML with a small optional script, relative links
 * throughout so the output works at a domain root or in any subfolder.
 *
 * Layout — each vault lives in its own folder, so vaults can share one site:
 *   index.html, style.css, script.js         shared, at the site root
 *   <vault>/index.html, search.json, feed.xml the vault's home, search index and RSS
 *   <vault>/<note>/index.html                 each note (journal entries use the date)
 */

export interface SitePage {
  page: Page
  /** Path inside the vault's folder, e.g. "my-idea" or "2026-09-22". */
  path: string
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

/** URL-safe name. The publisher (supabase/functions/nt-publish) has an identical copy — keep them in step. */
export function slugFor(title: string): string {
  const s = title.toLowerCase().normalize('NFKD')
    .replace(/([a-z])\p{M}+/gu, '$1')          // café → cafe, but keep marks that other scripts need (मराठी)
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 120).replace(/-$/, '')
  return s || 'note'
}

/** The folder a vault publishes into. */
export const vaultSlug = (v: Pick<Vault, 'name'>) => slugFor(v.name)

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
    let path = daily ? page.title : slugFor(page.title)
    if (used.has(path)) { let n = 2; while (used.has(`${path}-${n}`)) n++; path = `${path}-${n}` }
    used.add(path)
    included.push({ page, daily, path })
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

/** Note body → publishable HTML: comments removed, links resolved or flattened. `base` points at the vault folder. */
function renderBody(html: string, byTitle: Map<string, SitePage>, base: string): string {
  const body = parse(html)

  // private annotations never leave the app
  for (const el of [...body.querySelectorAll('[data-comment-id]')]) el.replaceWith(...el.childNodes)

  for (const el of [...body.querySelectorAll('a.wikilink')]) {
    const title = el.getAttribute('data-title') ?? el.textContent ?? ''
    const target = byTitle.get(normTitle(title))
    if (target) {
      const a = document.createElement('a')
      a.setAttribute('href', `${base}${target.path}/`)
      a.className = 'wikilink'
      a.textContent = el.textContent
      el.replaceWith(a)
    } else {
      // a link to something unpublished becomes plain text: no broken link, no link into anything private
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

function feed(plan: SitePlan, site: Vault, vaultUrl: string, byTitle: Map<string, SitePage>): string {
  const base = vaultUrl.replace(/\/$/, '')
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

const README = `# Notes

Static site published from Smart Journal. Plain HTML — no build step.
Each folder is one vault; the files at the top level are shared.
`

/**
 * The files for one vault, plus the shared root files.
 * `others` are the other vaults already published to the same site (listed on the landing page).
 */
export function buildSite(plan: SitePlan, vault: Vault, others: LandingVault[] = []): Record<string, string> {
  const slug = vaultSlug(vault)
  const siteRoot = (vault.site_url || '').replace(/\/?$/, '/')
  const vaultUrl = vault.site_url ? `${siteRoot}${slug}/` : ''
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
  const bodies = new Map(plan.included.map(s => [s.page.id, renderBody(s.page.body, byTitle, '../')]))
  const text = new Map([...bodies].map(([id, html]) => [id, (parse(html).textContent ?? '').replace(/\s+/g, ' ').trim()]))
  const ctx: ReaderCtx = { site: vault, plan, text, backlinks: back, vaultUrl, build: Date.now().toString(36) }

  const listed: LandingVault[] = [
    { slug, title: vault.site_title || vault.name, description: vault.site_description ?? '' },
    ...others.filter(o => o.slug !== slug),
  ]
  const files: Record<string, string> = {
    'index.html': readerLanding(listed),
    'style.css': READER_CSS,
    'script.js': READER_JS,
    '.nojekyll': '',
    'README.md': README,
    [`${slug}/index.html`]: readerHomePage(ctx),
    [`${slug}/search.json`]: readerSearchIndex(ctx),
  }
  for (const s of plan.included) files[`${slug}/${s.path}/index.html`] = readerNotePage(s, bodies.get(s.page.id)!, ctx)
  if (vaultUrl) files[`${slug}/feed.xml`] = feed(plan, vault, vaultUrl, byTitle)
  return files
}

/** Every other vault already on the site — anyone's, since several people publish to the same garden — for its landing page. */
export async function publishedOthers(except: string): Promise<LandingVault[]> {
  const { data, error } = await supabase.rpc('nt_published_vaults')
  if (error) throw error
  return ((data ?? []) as (LandingVault & { id: string })[]).filter(v => v.id !== except).map(({ slug, title, description }) => ({ slug, title, description }))
}

export interface GitHubStatus { configured: boolean; repo: string | null; branch: string; siteUrl: string | null }
export interface GitHubResult { commit: string; unchanged: boolean; repo: string; slug: string; siteUrl: string; vaultUrl: string; commitUrl: string }

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
  const files = buildSite(plan, vault, await publishedOthers(vault.id))
  const { data, error } = await supabase.functions.invoke('nt-publish', { body: { vault_id: vault.id, files } })
  if (error) throw await fnError(error)
  return data as GitHubResult
}

/** Build the site and hand the browser a .zip download (this vault only). */
export function downloadSite(plan: SitePlan, vault: Vault): number {
  const text = buildSite(plan, vault)
  const files = Object.fromEntries(Object.entries(text).map(([k, v]) => [k, strToU8(v)]))
  const zip = zipSync(files, { level: 6 })
  const blob = new Blob([zip as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${vaultSlug(vault)}-${new Date().toISOString().slice(0, 10)}.zip`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return Object.keys(files).length
}

/** Publish a vault without the review dialog (used after renaming an already-published vault). */
export async function republishVault(vault: Vault, pages: Page[]): Promise<GitHubResult> {
  const siteUrl = vault.site_url || (await githubStatus()).siteUrl || ''
  return publishToGitHub(planSite(pages), { ...vault, site_url: siteUrl })
}
