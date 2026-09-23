import { useEffect, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { githubStatus, republishVault, vaultSlug } from '../lib/publish'
import type { Vault } from '../lib/types'

interface Props {
  vault: Vault
  name: string
  onClose: () => void
}

/** Confirm a vault rename; a vault that is already on the site is republished under its new address. */
export function RenameVaultDialog({ vault, name, onClose }: Props) {
  const { vaults, updateVault, pagesIn } = useStore()
  const [stage, setStage] = useState<'ask' | 'saving' | 'publishing' | 'done'>('ask')
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const oldSlug = vault.published_slug ?? vaultSlug(vault)
  const newSlug = vaultSlug({ name })
  const onSite = vault.kind === 'public' && !!vault.published_slug
  const clash = vaults.find(v => v.id !== vault.id && vaultSlug(v) === newSlug)
  const busy = stage === 'saving' || stage === 'publishing'

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const confirm = async () => {
    setErr(null); setStage('saving')
    // the site title follows the name unless it had been set to something else
    const siteTitle = !vault.site_title || vault.site_title === vault.name ? name : vault.site_title
    const renamed: Vault = { ...vault, name, site_title: siteTitle }
    try {
      await updateVault(vault.id, { name, site_title: siteTitle })
      if (!onSite) { setStage('done'); return }
      const gh = await githubStatus()
      if (!gh.configured) { setNote('Renamed. GitHub publishing isn’t set up, so the site wasn’t updated.'); setStage('done'); return }
      setStage('publishing')
      const r = await republishVault(renamed, pagesIn(vault.id), vaults.map(v => v.id === vault.id ? renamed : v))
      setNote(r.unchanged ? 'Renamed. The site was already up to date.' : `Renamed and republished at ${r.vaultUrl}`)
      setStage('done')
    } catch (e) {
      setErr((e as Error).message)
      setStage('ask')
    }
  }

  return (
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal rename" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Pencil size={15} /> Rename vault</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="rename-body">
          <p className="rename-names"><span className="muted">“{vault.name}”</span> → <strong>“{name}”</strong></p>
          {onSite && oldSlug !== newSlug && <>
            <p>Its address on your site changes from <code>/{oldSlug}/</code> to <code>/{newSlug}/</code>, and the vault is republished now so the site matches.</p>
            <p className="muted small">Links people saved to the old address will stop working.</p>
          </>}
          {onSite && oldSlug === newSlug && <p>The site address stays <code>/{newSlug}/</code>; the vault is republished so its title updates.</p>}
          {clash && <p className="err-text">“{clash.name}” already uses the address <code>/{newSlug}/</code>. Choose a different name.</p>}
        </div>
        <div className="modal-foot">
          <div className="pub-status">
            {err && <span className="err-text">{err}</span>}
            {stage === 'saving' && <span className="muted small">Renaming…</span>}
            {stage === 'publishing' && <span className="muted small">Republishing…</span>}
            {stage === 'done' && <span className="pub-done">{note ?? 'Renamed.'}</span>}
          </div>
          <div className="pub-actions">
            {stage === 'done'
              ? <button className="btn primary" onClick={onClose}>Done</button>
              : <>
                  <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                  <button className="btn primary" onClick={confirm} disabled={busy || !!clash}>{onSite ? 'Rename & republish' : 'Rename'}</button>
                </>}
          </div>
        </div>
      </div>
    </div>
  )
}
