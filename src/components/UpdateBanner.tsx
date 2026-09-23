import { useRegisterSW } from 'virtual:pwa-register/react'

const CHECK_EVERY_MS = 30 * 60 * 1000

/**
 * The installed app keeps running its cached copy until it is restarted, so a new deploy can go
 * unnoticed (e.g. publishing with an old site generator). Offer the reload instead of waiting.
 */
export function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return
      const check = () => { if (navigator.onLine) reg.update().catch(() => {}) }
      setInterval(check, CHECK_EVERY_MS)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
    },
  })

  if (!needRefresh) return null
  return (
    <div className="update-bar" role="status">
      <span>A new version of Journal is ready.</span>
      <button className="btn small primary" onClick={() => updateServiceWorker(true)}>Reload</button>
      <button className="btn small" onClick={() => setNeedRefresh(false)}>Later</button>
    </div>
  )
}
