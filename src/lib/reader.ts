import type { Vault } from './types'
import type { SitePage, SitePlan } from './publish'
import { prettyDate } from './links'
import { icon } from './readerIcons'

/**
 * The published reader: the app's own layout (top bar, sidebar with filter + search, note pane,
 * backlinks) as static, read-only pages. Visual values mirror src/index.css — keep them in step.
 */

export interface ReaderCtx {
  site: Vault
  plan: SitePlan
  /** Plain text of each published page, by page id (comments and markup removed). */
  text: Map<string, string>
  backlinks: Map<string, SitePage[]>
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const siteName = (v: Vault) => v.site_title || v.name
const label = (s: SitePage, long = false) => s.daily ? prettyDate(s.page.title, !long) : s.page.title
const words = (t: string) => t.split(/\s+/).filter(Boolean).length
const excerpt = (t: string, n: number) => t.length > n ? t.slice(0, n).trimEnd() + '…' : t

function sidebar(ctx: ReaderCtx, prefix: string, current: string | null): string {
  // same order as the app's "all notes" view: most recently edited first
  const rows = [...ctx.plan.included]
    .sort((a, b) => b.page.updated_at.localeCompare(a.page.updated_at))
    .map((s, i) => `<li data-i="${i}" data-daily="${s.daily ? 1 : 0}" data-date="${s.daily ? s.page.title : ''}" data-path="${esc(s.path)}"${s.page.id === current ? ' class="on"' : ''}><a class="row-label${s.daily ? ' daily' : ''}" href="${prefix}${s.path}/" title="${esc(s.page.title)}">${esc(label(s))}</a></li>`)
    .join('')
  return `<aside class="side-col"><nav class="side" aria-label="Notes">
  <div class="side-head">
    <div class="seg">
      <button class="on" data-filter="all" title="All notes" aria-label="All notes">${icon('list', 15)}</button>
      <button data-filter="daily" title="Daily notes" aria-label="Daily notes">${icon('calendar', 15)}</button>
    </div>
    <input class="side-search" type="search" placeholder="Search notes" aria-label="Search notes" hidden>
    <span class="spacer"></span>
    <button class="icon-btn" data-action="search" title="Search" aria-label="Search">${icon('search', 16)}</button>
  </div>
  <ul class="side-list">${rows}<li class="empty" hidden>No matches</li></ul>
</nav></aside>`
}

function shell(o: { ctx: ReaderCtx; prefix: string; title: string; description?: string; canonical?: string; current: string | null; pane: string }): string {
  const { ctx, prefix } = o
  const hasFeed = !!ctx.site.site_url
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">\n` : ''}${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">\n` : ''}${hasFeed ? `<link rel="alternate" type="application/rss+xml" title="${esc(siteName(ctx.site))}" href="${prefix}feed.xml">\n` : ''}<script>try{var t=localStorage.getItem('sj-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;if(localStorage.getItem('sj-side')==='0')document.documentElement.dataset.side='closed'}catch(e){}</script>
<link rel="stylesheet" href="${prefix}style.css">
<script defer src="${prefix}script.js"></script>
</head>
<body data-root="${prefix}">
<div class="shell">
<header class="top">
  <div class="top-left">
    <button class="icon-btn" data-action="sidebar" title="Toggle sidebar" aria-label="Toggle sidebar">${icon('panelLeft')}</button>
    <a class="brand" href="${prefix}">${esc(siteName(ctx.site))}</a>
  </div>
  <div class="top-actions">
    ${hasFeed ? `<a class="icon-btn" href="${prefix}feed.xml" title="RSS feed" aria-label="RSS feed">${icon('rss')}</a>` : ''}
    <button class="icon-btn" data-action="theme" title="Switch theme" aria-label="Switch theme">${icon('moon')}</button>
  </div>
</header>
<div class="work">
${sidebar(ctx, prefix, o.current)}
<div class="scrim" data-action="sidebar"></div>
<main class="pane">
${o.pane}
</main>
</div>
</div>
</body>
</html>
`
}

export function readerNotePage(s: SitePage, bodyHtml: string, ctx: ReaderCtx): string {
  const prefix = '../../'
  const text = ctx.text.get(s.page.id) ?? ''
  const n = words(text)

  let head: string
  if (s.daily) {
    // ‹ older entry · › newer entry, among published journal entries
    const days = ctx.plan.included.filter(x => x.daily)
    const i = days.findIndex(x => x.page.id === s.page.id)
    const older = days[i + 1], newer = days[i - 1]
    const nav = (t: SitePage | undefined, name: 'left' | 'right', aria: string) => t
      ? `<a class="icon-btn" href="${prefix}${t.path}/" title="${esc(aria)}: ${esc(label(t))}" aria-label="${esc(aria)}">${icon(name)}</a>`
      : `<span class="icon-btn disabled" aria-hidden="true">${icon(name)}</span>`
    head = `<div class="daily-nav"><h1>${esc(label(s, true))}</h1>${nav(older, 'left', 'Older entry')}${nav(newer, 'right', 'Newer entry')}</div>`
  } else {
    head = `<h1>${esc(s.page.title)}</h1>`
  }

  const back = ctx.backlinks.get(s.page.id) ?? []
  const backlinks = back.length ? `
<nav class="backlinks" aria-label="Linked from">
  <h3>Linked from</h3>
  <ul>${back.map(b => `<li><a href="${prefix}${b.path}/"><span class="bl-title">${esc(label(b))}</span><span class="bl-snippet">${esc(excerpt(ctx.text.get(b.page.id) ?? '', 120))}</span></a></li>`).join('')}</ul>
</nav>` : ''

  const pane = `<div class="pane-head">${head}<span class="wc">${n} ${n === 1 ? 'word' : 'words'}</span></div>
<article class="note">
${bodyHtml}
</article>${backlinks}`

  return shell({
    ctx, prefix, current: s.page.id, pane,
    title: `${label(s, true)} — ${siteName(ctx.site)}`,
    description: excerpt(text, 160),
    canonical: ctx.site.site_url ? `${ctx.site.site_url.replace(/\/$/, '')}/${s.path}/` : undefined,
  })
}

export function readerHomePage(ctx: ReaderCtx): string {
  const days = ctx.plan.included.filter(s => s.daily)
  const notes = ctx.plan.included.filter(s => !s.daily)
  const link = (s: SitePage) => `<li><a class="wikilink" href="${s.path}/">${esc(label(s, true))}</a></li>`
  const pane = `<div class="pane-head"><h1>${esc(siteName(ctx.site))}</h1></div>
<article class="note">
${ctx.site.site_description ? `<p class="lede">${esc(ctx.site.site_description)}</p>` : ''}
${days.length ? `<h2>Journal</h2><ul>${days.slice(0, 30).map(link).join('')}</ul>` : ''}
${notes.length ? `<h2>Notes</h2><ul>${notes.map(link).join('')}</ul>` : ''}
</article>`
  return shell({
    ctx, prefix: '', current: null, pane,
    title: siteName(ctx.site),
    description: ctx.site.site_description ?? undefined,
    canonical: ctx.site.site_url || undefined,
  })
}

/** Lets the sidebar search note bodies, not just titles. */
export function readerSearchIndex(ctx: ReaderCtx): string {
  return JSON.stringify(ctx.plan.included.map(s => ({ p: s.path, x: (ctx.text.get(s.page.id) ?? '').slice(0, 20000).toLowerCase() })))
}

const TOKENS_LIGHT = `--bg: #ffffff; --bg2: #f6f7f8; --bg3: #ebedf0; --line: #e2e5e9;
  --fg: #1c1e21; --muted: #6f7680; --accent: #2f6fed; --accent-soft: rgba(47,111,237,0.12); color-scheme: light;`
const TOKENS_DARK = `--bg: #1b1d21; --bg2: #202328; --bg3: #2a2e35; --line: #30353d;
  --fg: #e6e8eb; --muted: #8e97a3; --accent: #7aa2ff; --accent-soft: rgba(122,162,255,0.16); color-scheme: dark;`

export const READER_CSS = `:root {
  ${TOKENS_LIGHT}
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${TOKENS_DARK} } }
:root[data-theme="dark"] { ${TOKENS_DARK} }

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
*::-webkit-scrollbar-thumb:hover { background: var(--muted); background-clip: padding-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--font); -webkit-text-size-adjust: 100%; }
body { overscroll-behavior: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
input { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; width: 100%; outline: none; }
input:focus { border-color: var(--accent); }
input[type=search]::-webkit-search-cancel-button { display: none; }
[hidden] { display: none !important; }

.icon-btn { width: 30px; height: 30px; border-radius: 6px; display: grid; place-items: center; color: var(--muted); flex: none; text-decoration: none; }
.icon-btn.disabled { opacity: 0.3; }
@media (hover: hover) { .icon-btn:not(.disabled):hover { background: var(--bg3); color: var(--fg); } }

/* shell */
.shell { height: 100%; height: 100dvh; display: flex; flex-direction: column; }
.top { flex: none; height: calc(40px + env(safe-area-inset-top, 0px)); padding: env(safe-area-inset-top, 0px) 8px 0; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); position: relative; z-index: 10; }
.top-left, .top-actions { display: flex; align-items: center; gap: 2px; min-width: 0; }
.brand { font-weight: 600; font-size: 14px; margin-left: 4px; color: var(--muted); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand:hover { color: var(--fg); }
.work { flex: 1; min-height: 0; display: flex; position: relative; }

/* sidebar */
.side-col { flex: 0 0 240px; min-width: 0; overflow: hidden; transition: flex-basis .22s ease, opacity .22s ease; }
:root[data-side="closed"] .side-col { flex-basis: 0; opacity: 0; pointer-events: none; }
.side { width: 240px; height: 100%; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--bg2); }
.side-head { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 12px; height: 42px; }
.side-head .spacer { flex: 1; }
.side-head input { flex: 1; min-width: 0; font-size: 14px; }
.searching .seg, .searching .spacer { display: none; }
.seg { display: inline-flex; gap: 1px; background: var(--bg3); border-radius: 6px; padding: 2px; }
.seg button { width: 28px; height: 24px; border-radius: 4px; display: grid; place-items: center; color: var(--muted); }
.seg button.on { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.side-list { list-style: none; margin: 0; padding: 0 0 12px; overflow: auto; flex: 1; }
.side-list li { border-bottom: 1px solid var(--line); }
.side-list a { display: block; padding: 7px 8px 7px 14px; font-size: 14px; color: var(--fg); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-list a.daily { font-variant-numeric: tabular-nums; }
.side-list li.on a { background: var(--accent-soft); }
@media (hover: hover) { .side-list li:not(.on) a:hover { background: var(--bg3); } }
.side-list li.empty { padding: 7px 14px; font-size: 14px; color: var(--muted); border-bottom: 0; }
.scrim { display: none; }

/* note pane: one note, centred ~680px measure like the app's single-note view */
.pane { flex: 1; min-width: 0; overflow: auto; display: flex; flex-direction: column; background: var(--bg); --gutter: max(40px, calc(50% - 340px)); }
.pane-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 14px var(--gutter) 0; }
.pane-head h1 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }
.daily-nav { display: flex; align-items: center; gap: 2px; min-width: 0; }
.daily-nav h1 { margin: 0 6px 0 0; }
.daily-nav .icon-btn { width: 26px; height: 26px; }
.wc { flex: none; height: 30px; display: inline-flex; align-items: center; font-size: 12px; color: var(--muted); white-space: nowrap; margin-left: auto; padding-left: 12px; }

.note { flex: 1 0 auto; padding: 22px var(--gutter) 48px; line-height: 1.6; overflow-wrap: break-word; }
.note > :first-child { margin-top: 0; }
.note p { margin: 0 0 0.4em; }
.note .lede { color: var(--muted); margin-bottom: 1em; }
.note h1, .note h2, .note h3 { line-height: 1.3; margin: 1em 0 0.3em; }
.note h1 { font-size: 1.5em; } .note h2 { font-size: 1.25em; } .note h3 { font-size: 1.1em; }
.note ul, .note ol { margin: 0 0 0.4em; padding-left: 1.25em; }
.note li { position: relative; }
.note li p { margin: 0; }
.note li > ul, .note li > ol { margin: 0; }
.note ul { list-style: none; }
.note ul > li::before { content: ''; position: absolute; left: -0.85em; top: 0.62em; width: 0.42em; height: 0.42em; border-radius: 50%; background: currentColor; }
.note a { color: var(--accent); text-decoration: none; }
.note a:hover { text-decoration: underline; }
.note a.wikilink { color: inherit; text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.note a.wikilink:hover { text-decoration-color: var(--fg); }
.note blockquote { margin: 0.4em 0; padding: 2px 14px; border-left: 3px solid var(--line); color: var(--muted); }
.note pre { background: var(--bg2); padding: 10px 12px; border-radius: 6px; overflow: auto; font-size: 0.92em; }
.note code { font-family: ui-monospace, Menlo, monospace; font-size: 0.92em; background: var(--bg3); padding: 1px 5px; border-radius: 4px; }
.note pre code { background: none; padding: 0; }
.note hr { border: 0; border-top: 1px solid var(--line); margin: 1em 0; }
.note img { max-width: 100%; border-radius: 6px; }
.note [data-youtube-video] { margin: 0.6em 0; } .note [data-youtube-video] iframe { max-width: 100%; border: 0; border-radius: 8px; }
.note iframe { max-width: 100%; }

.backlinks { flex: none; border-top: 1px solid var(--line); padding: 12px var(--gutter) 20px; }
.backlinks h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.backlinks ul { list-style: none; margin: 0; padding: 0; }
.backlinks a { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; margin-left: -8px; border-radius: 5px; color: inherit; text-decoration: none; }
@media (hover: hover) { .backlinks a:hover { background: var(--bg3); } }
.bl-title { font-weight: 500; font-size: 14px; }
.bl-snippet { font-size: 13px; color: var(--muted); }

/* phone: one column, sidebar slides over */
@media (max-width: 800px) {
  .pane { --gutter: 16px; }
  .pane-head { padding-top: 8px; }
  .side-col, :root[data-side="closed"] .side-col { position: absolute; inset: 0 auto 0 0; z-index: 30; width: 260px; flex-basis: 260px; opacity: 1; pointer-events: auto; transform: translateX(-100%); transition: transform .22s ease; }
  .side { width: 260px; }
  .work.side-open .side-col { transform: none; box-shadow: 8px 0 24px rgba(0,0,0,0.2); }
  .work.side-open .scrim { display: block; position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,0.25); }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`

export const READER_JS = `(function () {
  var root = document.documentElement, body = document.body
  var work = document.querySelector('.work'), side = document.querySelector('.side')
  var list = document.querySelector('.side-list'), input = document.querySelector('.side-search')
  var empty = list.querySelector('.empty')
  var rows = [].slice.call(list.querySelectorAll('li[data-path]'))
  var narrow = window.matchMedia('(max-width: 800px)')
  var SUN = ${JSON.stringify(icon('sun'))}, MOON = ${JSON.stringify(icon('moon'))}
  var get = function (k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  var set = function (k, v) { try { localStorage.setItem(k, v) } catch (e) {} }

  // theme: follows the system until the reader picks one
  var isDark = function () { var t = root.dataset.theme; return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches }
  var themeBtn = document.querySelector('[data-action=theme]')
  var paint = function () { themeBtn.innerHTML = isDark() ? SUN : MOON; themeBtn.title = isDark() ? 'Light theme' : 'Dark theme' }
  paint()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint)

  // sidebar filter (all / daily) and search
  var filter = get('sj-filter') === 'daily' ? 'daily' : 'all', q = '', index = null
  var loadIndex = function () {
    if (index) return
    index = {}
    fetch(body.dataset.root + 'search.json').then(function (r) { return r.json() }).then(function (a) {
      a.forEach(function (e) { index[e.p] = e.x }); apply()
    }).catch(function () {})
  }
  var apply = function () {
    var shown = 0
    var order = filter === 'daily'
      ? rows.slice().sort(function (a, b) { return b.dataset.date.localeCompare(a.dataset.date) })
      : rows.slice().sort(function (a, b) { return a.dataset.i - b.dataset.i })
    order.forEach(function (li) {
      var ok = (filter === 'all' || li.dataset.daily === '1')
      if (ok && q) {
        var t = li.textContent.toLowerCase(), x = index && index[li.dataset.path]
        ok = t.indexOf(q) >= 0 || (!!x && x.indexOf(q) >= 0)
      }
      li.hidden = !ok; if (ok) shown++
      list.insertBefore(li, empty)
    })
    empty.hidden = shown > 0 || !q
    side.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('on', b.dataset.filter === filter) })
  }
  var openSearch = function (open) {
    side.classList.toggle('searching', open); input.hidden = !open
    var btn = side.querySelector('[data-action=search]')
    btn.innerHTML = open ? ${JSON.stringify(icon('x', 16))} : ${JSON.stringify(icon('search', 16))}
    if (open) { input.focus(); loadIndex() } else { input.value = ''; q = ''; apply() }
  }
  input.addEventListener('input', function () { q = input.value.trim().toLowerCase(); apply() })
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') openSearch(false)
    if (e.key === 'Enter') { var first = rows.filter(function (li) { return !li.hidden })[0]; if (first) location.href = first.querySelector('a').href }
  })
  apply()
  var on = list.querySelector('li.on'); if (on) on.scrollIntoView({ block: 'nearest' })

  document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-filter]')
    if (f) { filter = f.dataset.filter; set('sj-filter', filter); apply(); return }
    var a = e.target.closest('[data-action]'); if (!a) return
    var act = a.dataset.action
    if (act === 'theme') { var next = isDark() ? 'light' : 'dark'; root.dataset.theme = next; set('sj-theme', next); paint() }
    if (act === 'search') openSearch(input.hidden)
    if (act === 'sidebar') {
      if (narrow.matches) work.classList.toggle('side-open')
      else { var closed = root.dataset.side === 'closed'; if (closed) delete root.dataset.side; else root.dataset.side = 'closed'; set('sj-side', closed ? '1' : '0') }
    }
  })
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'k')) { e.preventDefault(); if (narrow.matches) work.classList.add('side-open'); delete root.dataset.side; openSearch(true) }
  })
})()
`
