import { strToU8, zipSync } from 'fflate'
import type { Page, Vault } from './types'
import { isDailyTitle, normTitle, prettyDate } from './links'
import { plainText } from './html'

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
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-')
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

function layout(o: { title: string; site: string; body: string; prefix: string; description?: string; canonical?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">\n` : ''}${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">\n` : ''}<link rel="alternate" type="application/rss+xml" href="${o.prefix}feed.xml">
<link rel="stylesheet" href="${o.prefix}style.css">
</head>
<body>
<header class="site-head"><a class="site-name" href="${o.prefix}">${esc(o.site)}</a></header>
<main>
${o.body}
</main>
<footer class="site-foot"><a href="${o.prefix}">${esc(o.site)}</a></footer>
</body>
</html>
`
}

function notePage(s: SitePage, byTitle: Map<string, SitePage>, backlinks: SitePage[], site: Vault): string {
  const prefix = '../../'
  const heading = s.daily ? prettyDate(s.page.title) : s.page.title
  const when = new Date(s.page.updated_at).toISOString().slice(0, 10)
  const body = `<article class="note">
  <h1>${esc(heading)}</h1>
  <p class="meta"><time datetime="${when}">${s.daily ? 'Written' : 'Updated'} ${when}</time></p>
  ${renderBody(s.page.body, byTitle, prefix)}
</article>` + (backlinks.length ? `
<nav class="backlinks">
  <h2>Linked from</h2>
  <ul>${backlinks.map(b => `<li><a href="${prefix}${b.path}/">${esc(b.daily ? prettyDate(b.page.title) : b.page.title)}</a></li>`).join('')}</ul>
</nav>` : '')

  return layout({
    title: `${heading} — ${site.site_title || site.name}`,
    site: site.site_title || site.name,
    description: plainText(s.page.body, 160),
    canonical: site.site_url ? `${site.site_url.replace(/\/$/, '')}/${s.path}/` : undefined,
    prefix, body,
  })
}

function homePage(plan: SitePlan, site: Vault): string {
  const journal = plan.included.filter(s => s.daily)
  const notes = plan.included.filter(s => !s.daily)
  const item = (s: SitePage) => `<li><a href="${s.path}/">${esc(s.daily ? prettyDate(s.page.title) : s.page.title)}</a>${s.daily ? '' : `<span class="excerpt">${esc(plainText(s.page.body, 90))}</span>`}</li>`

  const body = `<div class="home">
  <h1>${esc(site.site_title || site.name)}</h1>
  ${site.site_description ? `<p class="lede">${esc(site.site_description)}</p>` : ''}
  ${journal.length ? `<section><h2>Journal</h2><ul class="list dated">${journal.map(item).join('')}</ul></section>` : ''}
  ${notes.length ? `<section><h2>Notes</h2><ul class="list">${notes.map(item).join('')}</ul></section>` : ''}
</div>`
  return layout({ title: site.site_title || site.name, site: site.site_title || site.name, description: site.site_description ?? undefined, prefix: '', body, canonical: site.site_url || undefined })
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

const STYLE = `:root {
  --bg: #fffdf9; --fg: #22201d; --muted: #6c6862; --line: #e6e1d8; --accent: #7a5c2e;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #17181a; --fg: #e8e6e2; --muted: #999691; --line: #2d2f33; --accent: #d8b177; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.65 var(--font); }
main, .site-head, .site-foot { max-width: 680px; margin: 0 auto; padding: 0 24px; }
.site-head { padding-top: 28px; padding-bottom: 28px; }
.site-name { font-size: 14px; font-weight: 600; letter-spacing: .02em; color: var(--muted); text-decoration: none; text-transform: uppercase; }
.site-name:hover { color: var(--fg); }
.site-foot { padding-top: 48px; padding-bottom: 56px; font-size: 13px; color: var(--muted); }
.site-foot a { color: var(--muted); }
a { color: var(--accent); }
a.wikilink { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
a.wikilink:hover { text-decoration-color: var(--accent); }
h1 { font-size: 30px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -.01em; }
h2 { font-size: 20px; margin: 32px 0 10px; }
h3 { font-size: 17px; margin: 24px 0 8px; }
.meta { margin: 0 0 28px; font-size: 13px; color: var(--muted); }
.lede { font-size: 19px; color: var(--muted); margin: 0 0 36px; }
p { margin: 0 0 18px; }
ul, ol { padding-left: 1.25em; }
li { margin-bottom: 4px; }
blockquote { margin: 18px 0; padding: 2px 18px; border-left: 3px solid var(--line); color: var(--muted); }
pre { background: rgba(127,127,127,.08); padding: 14px 16px; border-radius: 6px; overflow-x: auto; font-size: 14px; }
code { font-family: ui-monospace, Menlo, monospace; font-size: .92em; }
pre code { font-size: inherit; }
img, iframe { max-width: 100%; border-radius: 6px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
.list { list-style: none; padding: 0; }
.list li { margin-bottom: 12px; display: flex; flex-direction: column; }
.list a { text-decoration: none; font-weight: 500; }
.list a:hover { text-decoration: underline; }
.list .excerpt { font-size: 14px; color: var(--muted); }
.list.dated a { font-variant-numeric: tabular-nums; }
.backlinks { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); }
.backlinks h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
.backlinks ul { list-style: none; padding: 0; margin: 0; }
.backlinks a { text-decoration: none; }
.backlinks a:hover { text-decoration: underline; }
@media (max-width: 600px) { body { font-size: 16px; } h1 { font-size: 26px; } }
`

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

/** Full site as a map of path → file contents. */
export function buildSite(plan: SitePlan, vault: Vault): Record<string, Uint8Array> {
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

  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(homePage(plan, vault)),
    'style.css': strToU8(STYLE),
    '.nojekyll': strToU8(''),
    'README.md': strToU8(README(vault.site_title || vault.name)),
  }
  for (const s of plan.included) files[`${s.path}/index.html`] = strToU8(notePage(s, byTitle, back.get(s.page.id) ?? [], vault))
  if (vault.site_url) files['feed.xml'] = strToU8(feed(plan, vault, byTitle))
  return files
}

/** Build the site and hand the browser a .zip download. */
export function downloadSite(plan: SitePlan, vault: Vault): number {
  const files = buildSite(plan, vault)
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
