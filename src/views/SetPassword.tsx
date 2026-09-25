import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useStore } from '../lib/store'

/** After a password-reset link: choose a new password, then carry on into the journal. */
export function SetPassword() {
  const { session, endRecovery } = useStore()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== again) { setErr('The two passwords don’t match'); return }
    setBusy(true); setErr(null)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      endRecovery()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  // the link signs you in; without a session it has expired or was already used
  if (!session) return (
    <div className="login">
      <h1>Link expired</h1>
      <p className="muted">This reset link has expired or was already used.</p>
      <button className="btn primary" onClick={endRecovery}>Back to sign in</button>
    </div>
  )

  return (
    <form className="login" onSubmit={submit}>
      <h1>Set a new password</h1>
      <p className="muted">for {session.user.email}</p>
      <div className="field"><label>New password</label><input type="password" autoComplete="new-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} required minLength={6} /></div>
      <div className="field"><label>Type it again</label><input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required minLength={6} /></div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy}>{busy ? '…' : 'Save password'}</button>
    </form>
  )
}
