import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, GitBranch, Globe, Loader2, ShieldCheck, Upload, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { downloadSite, githubStatus, planSite, publishToGitHub, vaultSlug, waitUntilLive, type GitHubResult, type GitHubStatus } from '../lib/publish'
import { isDailyTitle, prettyDate } from '../lib/links'
import type { Vault } from '../lib/types'

interface Props {
  vault: Vault
  onClose: () => void
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Review exactly what will go public, then publish to GitHub (or export a zip). Nothing leaves without this step. */
export function PublishDialog({ vault, onClose }: Props) {
  const { pagesIn, updateVault, reload } = useStore()
  const [site, setSite] = useState({
    site_title: vault.site_title ?? vault.name,
    site_description: vault.site_description ?? '',
    site_author: vault.site_author ?? '',
  })
  const [gh, setGh] = useState<GitHubStatus | null>(null)
  const [ghErr, setGhErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'github' | 'zip' | null>(null)
  const [result, setResult] = useState<GitHubResult | null>(null)
  // after a publish GitHub takes a minute to rebuild: the link is offered once the new page is being served
  const [live, setLive] = useState<'waiting' | 'live' | 'slow' | null>(null)
  const closed = useRef(false)
  useEffect(() => () => { closed.current = true }, [])
  const [zipped, setZipped] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    githubStatus()
      .then(s => {
        setGh(s)
      })
      .catch(e => setGhErr((e as Error).message))
  }, [])

  const plan = useMemo(() => planSite(pagesIn(vault.id)), [pagesIn, vault.id])
  const label = (t: string) => isDailyTitle(t) ? prettyDate(t, true) : t
  const slug = vaultSlug(vault)

  const toGitHub = async () => {
    setBusy('github'); setErr(null); setResult(null)
    try {
      await updateVault(vault.id, settings())
      const r = await publishToGitHub(plan, { ...vault, ...settings() })
      setResult(r)
      setLive(r.unchanged ? 'live' : 'waiting')
      if (!r.unchanged) waitUntilLive(r, 180_000, () => closed.current).then(ok => { if (!closed.current) setLive(ok ? 'live' : 'slow') })
      await reload()   // the publisher records the vault's folder and publish time
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const toZip = async () => {
    setBusy('zip'); setErr(null)
    try {
      await updateVault(vault.id, settings())
      setZipped(downloadSite(plan, { ...vault, ...settings() }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const ready = gh?.configured
  // absolute address for the RSS feed and canonical links: where GitHub serves the site
  const settings = () => ({ ...site, site_url: gh?.siteUrl ?? vault.site_url ?? '' })

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal publish" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Globe size={16} /> Publish “{vault.name}”</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="publish-body">
          <div className="pub-target">
            {gh === null && !ghErr && <span className="muted">Checking GitHub…</span>}
            {ghErr && <span className="err-text">Could not reach the publisher: {ghErr}</span>}
            {gh && ready && <>
              <GitBranch size={15} />
              <span>Publishes to <a href={`https://github.com/${gh.repo}`} target="_blank" rel="noopener">{gh.repo}</a></span>
              <span className="pub-secure" title="The GitHub token is held by the server and never reaches this browser. Only this repo can be written, only by you."><ShieldCheck size={14} /> token held server-side</span>
            </>}
            {gh && !ready && <span className="muted">GitHub publishing isn’t set up yet — you can still export a zip.</span>}
          </div>
          {vault.published_at && <p className="muted small pub-last">Last published {ago(vault.published_at)}</p>}

          <div className="pub-fields">
            <label>Site title<input value={site.site_title} onChange={e => setSite({ ...site, site_title: e.target.value })} /></label>
            <label>Description<input value={site.site_description} placeholder="Shown under the title on the home page, and in search results" onChange={e => setSite({ ...site, site_description: e.target.value })} /></label>
          </div>

          <div className="pub-summary">
            <strong>{plan.included.length}</strong> {plan.included.length === 1 ? 'note goes' : 'notes go'} public
            {plan.skipped.length > 0 && <> · <span className="muted">{plan.skipped.length} held back</span></>}
          </div>

          <ul className="pub-list">
            {plan.included.map(s => (
              <li key={s.page.id}>
                <span className="pub-title">{label(s.page.title)}</span>
                <span className="pub-path">/{slug}/{s.path}/</span>
              </li>
            ))}
          </ul>

          {plan.skipped.length > 0 && (
            <details className="pub-details">
              <summary>{plan.skipped.length} not published</summary>
              <ul className="pub-list">
                {plan.skipped.map(s => (
                  <li key={s.page.id}><span className="pub-title">{label(s.page.title)}</span><span className="pub-path">{s.reason}</span></li>
                ))}
              </ul>
            </details>
          )}

          {plan.unresolved.length > 0 && (
            <details className="pub-details">
              <summary>{plan.unresolved.length} {plan.unresolved.length === 1 ? 'link becomes' : 'links become'} plain text</summary>
              <p className="muted small">These notes link to pages that are not being published, so the links render as ordinary words — no broken links, and no link into anything unpublished.</p>
              <ul className="pub-list">{plan.unresolved.map(t => <li key={t}><span className="pub-title">{t}</span></li>)}</ul>
            </details>
          )}
        </div>

        <div className="modal-foot">
          <div className="pub-status">
            {err && <span className="err-text">{err}</span>}
            {!err && result && (result.unchanged
              ? <span className="muted small">Nothing changed since the last publish.</span>
              : live === 'waiting'
                ? <span className="pub-done"><Loader2 size={12} className="spin" /> Published · going live — GitHub usually takes under a minute…</span>
                : <span className="pub-done">{live === 'slow' ? 'Published · GitHub is slow to update, the page may show the old version for a few minutes' : 'Live'} · <a href={result.commitUrl} target="_blank" rel="noopener">commit {result.commit.slice(0, 7)}</a> · <a href={result.vaultUrl} target="_blank" rel="noopener">view site <ExternalLink size={11} /></a></span>)}
            {!err && !result && zipped !== null && <span className="pub-done">Downloaded {zipped} files.</span>}
          </div>
          <div className="pub-actions">
            <button className="btn" onClick={toZip} disabled={!!busy || !plan.included.length} title="Download a folder you can upload anywhere">
              <Download size={15} /> {busy === 'zip' ? 'Building…' : 'Zip'}
            </button>
            {ready && (
              <button className="btn primary" onClick={toGitHub} disabled={!!busy || !plan.included.length}>
                <Upload size={15} /> {busy === 'github' ? 'Publishing…' : 'Publish'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
