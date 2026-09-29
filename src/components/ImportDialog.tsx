import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileArchive, FolderOpen, Globe, Import, Lock, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { SOURCE_NAMES, detect, planImport, readPicked, type ImportPlan, type Source } from '../lib/importNotes'
import type { VaultKind } from '../lib/types'

const HOW: Record<Source, string> = {
  obsidian: 'Pick your vault’s folder (the one with your .md files).',
  logseq: 'Pick your graph’s folder (the one with journals/ and pages/ in it).',
  roam: 'In Roam: ⋯ → Export All → JSON (or Markdown). Pick the .zip or .json it downloads.',
}

/** Import an Obsidian vault, a Logseq graph or a Roam export into a new vault of its own. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { vaults, createVault, importPages, setVault } = useStore()
  const folder = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<VaultKind>('private')
  const [stage, setStage] = useState<'pick' | 'reading' | 'ready' | 'saving' | 'done'>('pick')
  const [saved, setSaved] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  const picked = async (list: FileList | null) => {
    if (!list?.length) return
    setErr(null); setStage('reading')
    try {
      const { files, imageFiles } = await readPicked([...list])
      const source = detect(files)
      if (!source) { setErr('No notes found there — pick the folder with your .md files, or Roam’s .zip / .json export.'); setStage('pick'); return }
      const p = planImport(files, source, imageFiles)
      if (!p.notes.length) { setErr('No notes found there.'); setStage('pick'); return }
      setPlan(p)
      // a name no vault has yet
      let n = SOURCE_NAMES[source], k = 1
      while (vaults.some(v => v.name.toLowerCase() === n.toLowerCase())) n = `${SOURCE_NAMES[source]} ${++k}`
      setName(n)
      setStage('ready')
    } catch (e) { setErr((e as Error).message); setStage('pick') }
  }

  const run = async () => {
    if (!plan || !name.trim()) return
    if (vaults.some(v => v.name.toLowerCase() === name.trim().toLowerCase())) { setErr('A vault has that name already — pick another, so the notes stay apart.'); return }
    setErr(null); setStage('saving'); setSaved(0)
    try {
      const v = await createVault(name.trim(), kind)
      await importPages(v.id, plan.notes, setSaved)
      setVault(v.id)
      setStage('done')
    } catch (e) { setErr((e as Error).message); setStage('ready') }
  }

  const busy = stage === 'reading' || stage === 'saving'
  return createPortal(
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal import" role="dialog" aria-label="Import notes" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Import size={16} /> Import notes</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="import-body">
          {(stage === 'pick' || stage === 'reading') && <>
            <p>Bring in your notes from <strong>Obsidian</strong>, <strong>Logseq</strong> or <strong>Roam</strong>. They go into a new vault of their own, so your notes here don’t get mixed up.</p>
            <ul className="import-how">
              {(Object.keys(HOW) as Source[]).map(s => <li key={s}><strong>{SOURCE_NAMES[s]}</strong> — {HOW[s]}</li>)}
            </ul>
            <div className="import-pick">
              <button className="btn" onClick={() => folder.current?.click()} disabled={busy}><FolderOpen size={15} /> Choose a folder</button>
              <button className="btn" onClick={() => file.current?.click()} disabled={busy}><FileArchive size={15} /> Choose a .zip or .json</button>
              {stage === 'reading' && <span className="muted small">Reading…</span>}
            </div>
            {/* webkitdirectory: the whole folder, sub-folders included */}
            <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => picked(e.target.files)} />
            <input ref={file} type="file" hidden multiple accept=".zip,.json,.md,.markdown" onChange={e => picked(e.target.files)} />
          </>}
          {plan && (stage === 'ready' || stage === 'saving') && <>
            <div className="import-summary">
              <div><strong>{SOURCE_NAMES[plan.source]}</strong> notes found</div>
              <div className="import-stats">
                <span><b>{plan.days.toLocaleString()}</b> journal {plan.days === 1 ? 'day' : 'days'}</span>
                <span><b>{plan.pages.toLocaleString()}</b> {plan.pages === 1 ? 'page' : 'pages'}</span>
                <span><b>{plan.links.toLocaleString()}</b> {plan.links === 1 ? 'link' : 'links'}</span>
              </div>
              <p className="muted small">Links between notes keep working, and so do backlinks. Daily notes join this vault’s journal. Links to websites stay links.
                {plan.images > 0 && <> <b>{plan.images.toLocaleString()} images</b> aren’t copied yet: pictures on the web become links, pictures on your disk are marked 🖼 with their name.</>}
                {plan.skipped.length > 0 && <> {plan.skipped.length} file(s) couldn’t be read.</>}</p>
            </div>
            <label className="import-field"><span>New vault’s name</span>
              <input value={name} maxLength={60} onChange={e => setName(e.target.value)} disabled={stage === 'saving'} autoFocus /></label>
            <div className="seg wide">
              <button className={kind === 'private' ? 'on' : ''} onClick={() => setKind('private')} disabled={stage === 'saving'}><Lock size={12} /> Private</button>
              <button className={kind === 'public' ? 'on' : ''} onClick={() => setKind('public')} disabled={stage === 'saving'}><Globe size={12} /> Public</button>
            </div>
            {stage === 'saving' && (
              <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={plan.notes.length} aria-valuenow={saved}>
                <div style={{ width: `${Math.round((saved / plan.notes.length) * 100)}%` }} />
                <span>{saved.toLocaleString()} of {plan.notes.length.toLocaleString()} saved…</span>
              </div>
            )}
          </>}
          {stage === 'done' && plan && (
            <p className="import-done">Done — {plan.notes.length.toLocaleString()} notes are in the vault <strong>{name}</strong>, which is open now.</p>
          )}
          {err && <div className="err">{err}</div>}
        </div>
        <div className="tool-actions">
          {stage === 'ready' && <button className="btn small" onClick={() => { setPlan(null); setStage('pick') }}>Back</button>}
          <span className="spacer" />
          {stage === 'done'
            ? <button className="btn primary small" onClick={onClose}>Close</button>
            : <>
                <button className="btn small" onClick={onClose} disabled={busy}>Cancel</button>
                {plan && <button className="btn primary small" onClick={run} disabled={busy || !name.trim()}>{stage === 'saving' ? 'Importing…' : `Import ${plan.notes.length.toLocaleString()} notes`}</button>}
              </>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
