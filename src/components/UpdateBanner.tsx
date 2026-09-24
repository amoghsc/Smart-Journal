import { useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useStore } from '../lib/store'

const CHECK_EVERY_MS = 30 * 60 * 1000

/**
 * New versions of the app wait until you say so. The window where you press Reload saves pending edits,
 * then reloads. Every other open window is left alone — it only shows that a new version is active —
 * so nothing reloads under you while you type.
 */
export function UpdateBanner() {
  const { saveNow } = useStore()
  const requestedHere = useRef(false)
  const [activeElsewhere, setActiveElsewhere] = useState(false)

  const reloadSafely = async () => {
    try { await saveNow() } finally { window.location.reload() }
  }

  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return
      const check = () => { if (navigator.onLine) reg.update().catch(() => {}) }
      setInterval(check, CHECK_EVERY_MS)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
    },
    // the new version has taken over: reload only if it was asked for in this window
    onNeedReload() {
      if (requestedHere.current) reloadSafely()
      else { setNeedRefresh(false); setActiveElsewhere(true) }
    },
  })

  const update = async () => {
    requestedHere.current = true
    await saveNow()
    await updateServiceWorker(true)
    // if the switch-over doesn't report back, reload anyway
    setTimeout(reloadSafely, 4000)
  }

  if (activeElsewhere) return (
    <div className="update-bar" role="status">
      <span>Journal was updated in another window.</span>
      <button className="btn small primary" onClick={reloadSafely}>Reload</button>
      <button className="btn small" onClick={() => setActiveElsewhere(false)}>Later</button>
    </div>
  )
  if (!needRefresh) return null
  return (
    <div className="update-bar" role="status">
      <span>A new version of Journal is ready.</span>
      <button className="btn small primary" onClick={update}>Reload</button>
      <button className="btn small" onClick={() => setNeedRefresh(false)}>Later</button>
    </div>
  )
}
