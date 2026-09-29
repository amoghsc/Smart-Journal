import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FolderOpen, HardDriveDownload, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { toast } from '../lib/toast'
import {
  BACKUP_EVENT, BACKUP_EVERY_MS, backupStatus, backupZip, canBackUpToFolder, chooseBackupFolder, loadBackupState, resumeBackup, runBackup, stopBackup,
  type BackupStatus,
} from '../lib/backup'

/** The backup's state, kept current. */
export function useBackupStatus(): BackupStatus {
  const [s, setS] = useState(backupStatus)
  useEffect(() => {
    const on = (e: Event) => setS((e as CustomEvent<BackupStatus>).detail)
    window.addEventListener(BACKUP_EVENT, on)
    return () => window.removeEventListener(BACKUP_EVENT, on)
  }, [])
  return s
}

export const agoText = (t: number | null) => {
  if (!t) return 'not yet'
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Runs the backup: a few seconds after opening, every few minutes, and as the app goes to the background.
 * When the browser wants permission again (after a restart), a small bar offers to resume.
 */
export function BackupRunner() {
  const { allPages, vaults } = useStore()
  const latest = useRef({ allPages, vaults }); latest.current = { allPages, vaults }
  const s = useBackupStatus()
  useEffect(() => {
    loadBackupState()
    const run = () => { const { allPages: p, vaults: v } = latest.current; if (p.length && v.length) runBackup(p, v) }
    const first = window.setTimeout(run, 8000)
    const every = window.setInterval(run, BACKUP_EVERY_MS)
    const hidden = () => { if (document.visibilityState === 'hidden') run() }
    document.addEventListener('visibilitychange', hidden)
    return () => { clearTimeout(first); clearInterval(every); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  if (!s.on || !s.needsPermission) return null
  return (
    <div className="update-bar backup-bar">
      <HardDriveDownload size={15} /> Backups to “{s.folder}” are paused
      <button className="btn primary small" onClick={async () => { if (await resumeBackup()) { const { allPages: p, vaults: v } = latest.current; runBackup(p, v) } }}>Resume</button>
    </div>
  )
}

/** Settings → Backup: choose the folder, see when it last ran, back up now; or download everything as a .zip. */
export function BackupDialog({ onClose }: { onClose: () => void }) {
  const { allPages, vaults } = useStore()
  const s = useBackupStatus()
  const [busy, setBusy] = useState(false)
  const folderOk = canBackUpToFolder()
  const count = allPages.filter(p => !p.local && p.kind !== 'canvas').length

  const now = async () => {
    setBusy(true)
    const n = await runBackup(allPages, vaults)
    setBusy(false)
    const st = backupStatus()
    if (st.error) toast('Backup failed', st.error)
    else toast(n ? `Backed up ${n} ${n === 1 ? 'note' : 'notes'}` : 'Backup is up to date')
  }
  const choose = async () => {
    if (await chooseBackupFolder()) { setBusy(true); const n = await runBackup(allPages, vaults); setBusy(false); toast(`Backup on — ${n} notes written`) }
  }
  const zip = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(backupZip(allPages, vaults))
    a.download = `Smart Journal backup ${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal backup" role="dialog" aria-label="Backup to this device" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><HardDriveDownload size={16} /> Backup to this device</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="import-body">
          <p>A copy of all your notes ({count.toLocaleString()}) in a folder on this device, updated every {BACKUP_EVERY_MS / 60_000} minutes while the app is open — yours even if the cloud copy is ever lost.</p>
          <pre className="backup-tree">{'<your folder>/\n  <Vault>/\n    Journal/2026/2026-09-28.md\n    Notes/My note.md\n    _Deleted/   (notes deleted in the app)'}</pre>
          <p className="muted small">One Markdown file per note: any text editor opens it, and apps like Obsidian or Typora show the formatting and links. Its details (dates, words, time spent) are at the top. The backup never deletes a file.</p>
          {folderOk ? (
            s.on ? (
              <div className="import-summary">
                <div>Backing up to <strong>{s.folder}</strong> · updated {agoText(s.last)}{s.writing ? ' · writing…' : ''}</div>
                {s.needsPermission && <div className="err-text">Paused: the browser needs your OK again.</div>}
                {s.error && <div className="err-text">{s.error}</div>}
              </div>
            ) : <p className="muted small">Pick (or create) a folder, e.g. Documents/Smart Journal. Your browser will ask to let the app save there.</p>
          ) : (
            <p className="muted small">This browser can’t keep a folder up to date (that needs Chrome, Edge, Arc or Brave on a computer). You can download everything as a .zip instead, whenever you like.</p>
          )}
        </div>
        <div className="tool-actions">
          {folderOk && s.on && <button className="btn small" onClick={() => stopBackup()} disabled={busy}>Turn off</button>}
          <button className="btn small" onClick={zip} title="Every note, laid out the same way, in one .zip"><Download size={13} /> Download .zip</button>
          <span className="spacer" />
          {folderOk && (s.on
            ? <>
                <button className="btn small" onClick={choose} disabled={busy}><FolderOpen size={13} /> Change folder</button>
                <button className="btn primary small" onClick={async () => { if (s.needsPermission && !(await resumeBackup())) return; now() }} disabled={busy}>{busy ? 'Backing up…' : 'Back up now'}</button>
              </>
            : <button className="btn primary small" onClick={choose} disabled={busy}><FolderOpen size={13} /> Choose folder</button>)}
        </div>
      </div>
    </div>,
    document.body,
  )
}
