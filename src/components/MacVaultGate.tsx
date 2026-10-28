import { useState } from 'react'
import { FolderOpen, Laptop, Loader2 } from 'lucide-react'
import { useStore } from '../lib/store'
import { pickFolder } from '../lib/macVault'
import type { Vault } from '../lib/types'

/** In place of the notes of a vault on this Mac that can't be read yet: why, and the one click that fixes it. */
export function MacVaultGate({ vault }: { vault: Vault }) {
  const { macStatus, allowFolder, reconnectFolder } = useStore()
  const st = macStatus[vault.id] ?? 'loading'
  const [err, setErr] = useState<string | null>(null)
  const run = (f: () => Promise<unknown>) => { setErr(null); f().catch(e => setErr((e as Error).message)) }
  const find = () => run(async () => { const dir = await pickFolder(); if (dir) await reconnectFolder(vault.id, dir) })
  return (
    <div className="mac-gate">
      {st === 'loading' ? <Loader2 size={26} className="spin" /> : <Laptop size={28} />}
      <h2>{vault.name}</h2>
      {st === 'loading' && <p>Opening its folder on this Mac…</p>}
      {st === 'permission' && <>
        <p>This vault is a folder on your Mac. The browser needs your OK to open it again (it asks after a restart — choose “Allow on every visit” to stop that).</p>
        <button className="btn primary" onClick={() => run(() => allowFolder(vault.id))}>Open the folder</button>
      </>}
      {st === 'missing' && <>
        <p>This vault is a folder on your Mac, but this browser doesn’t know where it is (it may have moved, or this is another browser). Point to it once.</p>
        <button className="btn primary" onClick={find}><FolderOpen size={15} /> Find the folder…</button>
      </>}
      {st === 'unsupported' && <p>This vault is a folder on your Mac. This browser can’t open folders — use Comet, Chrome, Edge or Arc on the Mac.</p>}
      {st === 'error' && <>
        <p>The folder couldn’t be read.</p>
        <button className="btn" onClick={find}><FolderOpen size={15} /> Find the folder…</button>
      </>}
      {err && <div className="err">{err}</div>}
    </div>
  )
}
