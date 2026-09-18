import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const forgot = async () => {
    if (!email.trim()) { setErr('Enter your email first'); return }
    setBusy(true); setErr(null); setMsg(null)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
      if (error) throw error
      setMsg('Reset link sent to your email.')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null); setMsg(null)
    try {
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw error
      } else {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
        if (error) throw error
        if (!data.session) setMsg('Account created. Check your email for a confirmation link, then sign in.')
      }
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Smart Journal</h1>
      <p className="muted">Daily notes, linked pages, infinite canvas</p>
      <div className="field"><label>Email</label><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
      <div className="field"><label>Password</label><input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={6} /></div>
      {err && <div className="err">{err}</div>}
      {msg && <div className="note-msg">{msg}</div>}
      <button className="btn primary" disabled={busy}>{busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
      {mode === 'in' && <p className="center"><button type="button" className="link" onClick={forgot} disabled={busy}>Forgot password?</button></p>}
      <p className="center">
        {mode === 'in'
          ? <>First time here? <button type="button" className="link" onClick={() => setMode('up')}>Create an account</button></>
          : <>Already have an account? <button type="button" className="link" onClick={() => setMode('in')}>Sign in</button></>}
      </p>
    </form>
  )
}
