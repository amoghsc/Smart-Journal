import { useMemo, useState } from 'react'
import { Download, Globe, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { downloadSite, planSite } from '../lib/publish'
import { isDailyTitle, prettyDate } from '../lib/links'
import type { Vault } from '../lib/types'

interface Props {
  vault: Vault
  onClose: () => void
}

/** Review exactly what will go public, then export the site. Nothing leaves without this step. */
export function PublishDialog({ vault, onClose }: Props) {
  const { pagesIn, updateVault } = useStore()
  const [site, setSite] = useState({
    site_title: vault.site_title ?? vault.name,
    site_description: vault.site_description ?? '',
    site_author: vault.site_author ?? '',
    site_url: vault.site_url ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)

  const plan = useMemo(() => planSite(pagesIn(vault.id)), [pagesIn, vault.id])
  const label = (t: string) => isDailyTitle(t) ? prettyDate(t, true) : t

  const publish = async () => {
    setBusy(true)
    try {
      await updateVault(vault.id, site)
      setDone(downloadSite(plan, { ...vault, ...site }))
    } catch (e) { alert((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal publish" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Globe size={16} /> Publish “{vault.name}”</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="publish-body">
          <div className="pub-fields">
            <label>Site title<input value={site.site_title} onChange={e => setSite({ ...site, site_title: e.target.value })} /></label>
            <label>Description<input value={site.site_description} placeholder="One line under the title" onChange={e => setSite({ ...site, site_description: e.target.value })} /></label>
            <label>Site address<input value={site.site_url} placeholder="https://notes.example.com — needed for the RSS feed" onChange={e => setSite({ ...site, site_url: e.target.value })} /></label>
          </div>

          <div className="pub-summary">
            <strong>{plan.included.length}</strong> {plan.included.length === 1 ? 'note goes' : 'notes go'} public
            {plan.skipped.length > 0 && <> · <span className="muted">{plan.skipped.length} held back</span></>}
          </div>

          <ul className="pub-list">
            {plan.included.map(s => (
              <li key={s.page.id}>
                <span className="pub-title">{label(s.page.title)}</span>
                <span className="pub-path">/{s.path}/</span>
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
              <p className="muted small">These notes link to pages that are not being published, so the links render as ordinary words — no broken links, and the titles of unpublished notes stay private.</p>
              <ul className="pub-list">{plan.unresolved.map(t => <li key={t}><span className="pub-title">{t}</span></li>)}</ul>
            </details>
          )}
        </div>

        <div className="modal-foot">
          {done !== null
            ? <span className="pub-done">Downloaded — {done} files. Upload the folder's contents to your host.</span>
            : <span className="muted small">Exports a plain HTML folder. Nothing is uploaded anywhere.</span>}
          <button className="btn primary" onClick={publish} disabled={busy || !plan.included.length}>
            <Download size={15} /> {busy ? 'Building…' : done !== null ? 'Export again' : 'Export site'}
          </button>
        </div>
      </div>
    </div>
  )
}
