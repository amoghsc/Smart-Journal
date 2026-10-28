import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderOpen, Laptop, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { pickFolder } from '../lib/macVault'
import { toast } from '../lib/toast'

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'Vault'

type Done = { vaultId: string; name: string; dir: FileSystemDirectoryHandle; notes: number; canvases: number; pieces: number }

/**
 * Move vaults from the cloud to this Mac: pick one folder (e.g. Documents/Smart Journal) and each vault gets a folder
 * of its own inside it. Every note is written, then read back and compared; the cloud copies are deleted only after
 * that, and only when you say so.
 */
export function MoveToMacDialog({ onClose }: { onClose: () => void }) {
  const { vaults, pagesIn, moveVaultToMac, finishMoveToMac } = useStore()
  const cloud = vaults.filter(v => v.storage !== 'mac')
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(cloud.map(v => v.id)))
  const [stage, setStage] = useState<'pick' | 'copying' | 'checked' | 'finishing' | 'done'>('pick')
  const [now, setNow] = useState<{ name: string; done: number; total: number } | null>(null)
  const [done, setDone] = useState<Done[]>([])
  const [err, setErr] = useState<string | null>(null)
  const total = cloud.filter(v => chosen.has(v.id)).reduce((n, v) => n + pagesIn(v.id).length, 0)

  const start = async () => {
    const parent = await pickFolder()
    if (!parent) return
    setErr(null); setStage('copying')
    const out: Done[] = []
    try {
      for (const v of cloud.filter(x => chosen.has(x.id))) {
        // its own folder inside the one picked (a second vault with the same name gets " 2")
        let name = safe(v.name), n = 1
        while (out.some(d => d.dir.name === name)) name = `${safe(v.name)} ${++n}`
        const dir = await parent.getDirectoryHandle(name, { create: true })
        setNow({ name: v.name, done: 0, total: pagesIn(v.id).length })
        const r = await moveVaultToMac(v.id, dir, (d, t) => setNow({ name: v.name, done: d, total: t }))
        out.push({ vaultId: v.id, name: v.name, dir, ...r })
        setDone([...out])
      }
      setStage('checked')
    } catch (e) { setErr((e as Error).message); setStage(out.length ? 'checked' : 'pick') }
    setNow(null)
  }

  const finish = async () => {
    setStage('finishing'); setErr(null)
    try {
      for (const d of done) await finishMoveToMac(d.vaultId, d.dir)
      setStage('done')
      toast(`${done.length} ${done.length === 1 ? 'vault is' : 'vaults are'} on your Mac now`, 'Their cloud copies are deleted')
    } catch (e) { setErr((e as Error).message); setStage('checked') }
  }

  const busy = stage === 'copying' || stage === 'finishing'
  return createPortal(
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal import" role="dialog" aria-label="Move vaults to this Mac" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Laptop size={16} /> Move vaults to this Mac</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="import-body">
          {stage === 'pick' && <>
            <p>The vaults you pick become folders of Markdown files on this Mac, and their notes leave the cloud. Pick one folder — say <b>Documents/Smart Journal</b> — and each vault gets a folder of its own inside it.</p>
            <ul className="move-list">
              {cloud.map(v => (
                <li key={v.id}><label>
                  <input type="checkbox" checked={chosen.has(v.id)} onChange={e => setChosen(c => { const n = new Set(c); if (e.target.checked) n.add(v.id); else n.delete(v.id); return n })} />
                  <span className="move-name">{v.name}</span><span className="muted small">{pagesIn(v.id).length} notes</span>
                </label></li>
              ))}
            </ul>
            <p className="muted small">Every note is copied, then read back from the folder and compared. Nothing is deleted from the cloud until all of it matches and you say so. Publishing still works from vaults on this Mac.</p>
          </>}
          {stage === 'copying' && now && (
            <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={now.total} aria-valuenow={now.done}>
              <div style={{ width: `${Math.round((now.done / Math.max(1, now.total)) * 100)}%` }} />
              <span>{now.name}: {now.done.toLocaleString()} of {now.total.toLocaleString()} notes copied…</span>
            </div>
          )}
          {done.length > 0 && (
            <ul className="move-list">
              {done.map(d => (
                <li key={d.vaultId}><Check size={13} className="ok" /> <b>{d.name}</b> → <span className="muted">{d.dir.name}/</span> · {d.notes.toLocaleString()} notes checked
                  {d.canvases ? ` · ${d.canvases} canvas` : ''}</li>
              ))}
            </ul>
          )}
          {stage === 'checked' && <p className="import-done">Everything above is on your Mac and reads back exactly. Delete the cloud copies now? After this, these vaults live only in their folders (keep Time Machine on).</p>}
          {stage === 'done' && <p className="import-done">Done — {done.length} {done.length === 1 ? 'vault lives' : 'vaults live'} on your Mac now. Nothing of their notes is left in the cloud.</p>}
          {err && <div className="err">{err}</div>}
        </div>
        <div className="tool-actions">
          <span className="spacer" />
          {stage === 'pick' && <>
            <button className="btn small" onClick={onClose}>Cancel</button>
            <button className="btn primary small" onClick={start} disabled={!chosen.size}><FolderOpen size={13} /> Choose folder and copy {total.toLocaleString()} notes</button>
          </>}
          {stage === 'checked' && <>
            <button className="btn small" onClick={onClose} title="The copies stay in the folders; the vaults stay in the cloud for now">Not now</button>
            <button className="btn primary small" onClick={finish}>Delete cloud copies</button>
          </>}
          {(stage === 'copying' || stage === 'finishing') && <span className="muted small">{stage === 'copying' ? 'Copying and checking…' : 'Switching over…'}</span>}
          {stage === 'done' && <button className="btn primary small" onClick={onClose}>Close</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
