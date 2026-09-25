import { useSyncExternalStore } from 'react'

/**
 * Time spent with a note: every note visible on screen accrues time while you're using the app.
 *
 * - Any input (typing, clicks, scrolling, moving the mouse, selecting) counts as activity.
 * - Up to a minute after the last activity counts as reading.
 * - Between one and five minutes of no activity is held back: kept if you come back, dropped if you don't.
 * - After five minutes of no activity nothing counts until you're active again. A hidden tab never counts.
 *
 * Seconds are saved to the note in the background (nt_add_time), roughly once a minute.
 */

const TICK_MS = 5_000
const GRACE_MS = 60_000
const IDLE_MS = 5 * 60_000
const SAVE_MS = 60_000

const pending = new Map<string, number>()    // counted, not yet saved
const tentative = new Map<string, number>()  // accrued while idle; confirmed by the next activity
const inflight = new Map<string, number>()   // being saved right now (still shown until the save lands)
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const bump = (m: Map<string, number>, id: string, s: number) => m.set(id, (m.get(id) ?? 0) + s)

/** Seconds counted on this device that the note's saved total doesn't include yet. */
export function useUnsavedSeconds(id: string | undefined): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => id ? Math.floor((pending.get(id) ?? 0) + (tentative.get(id) ?? 0) + (inflight.get(id) ?? 0)) : 0,
  )
}

/** "12 mins.", "3 hrs. 34 mins."; empty under a minute. */
export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds / 60)
  if (total < 1) return ''
  const h = Math.floor(total / 60), m = total % 60
  const hrs = h ? `${h} ${h === 1 ? 'hr.' : 'hrs.'}` : ''
  const mins = m ? `${m} ${m === 1 ? 'min.' : 'mins.'}` : ''
  return [hrs, mins].filter(Boolean).join(' ')
}

/** Start counting. `visible` returns the ids of saved notes on screen; `save` adds seconds to a note. Returns a stop function. */
export function startActiveTime(visible: () => string[], save: (id: string, seconds: number) => Promise<void>): () => void {
  let lastActivity = Date.now()
  let lastTick = Date.now()

  const activity = () => {
    const now = Date.now()
    if (now - lastActivity < IDLE_MS) for (const [id, s] of tentative) bump(pending, id, s)
    if (tentative.size) { tentative.clear(); emit() }
    lastActivity = now
  }
  let lastMove = 0
  const onMove = () => { const now = Date.now(); if (now - lastMove > 2_000) { lastMove = now; activity() } }

  const tick = () => {
    const now = Date.now()
    const dt = Math.min(now - lastTick, TICK_MS * 3) / 1000   // a sleeping laptop doesn't count
    lastTick = now
    if (document.visibilityState !== 'visible') return
    const idle = now - lastActivity
    if (idle >= IDLE_MS) { if (tentative.size) { tentative.clear(); emit() } return }
    const ids = visible()
    if (!ids.length) return
    const into = idle <= GRACE_MS ? pending : tentative
    for (const id of ids) bump(into, id, dt)
    emit()
  }

  const flush = () => {
    for (const [id, s] of pending) {
      const whole = Math.floor(s)
      if (whole < 1) continue
      pending.set(id, s - whole)
      bump(inflight, id, whole)
      save(id, whole)
        .catch(() => bump(pending, id, whole))   // try again next time
        .finally(() => { bump(inflight, id, -whole); emit() })
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') { lastTick = Date.now(); activity() }
    else { tick(); flush() }
  }

  const opts = { capture: true, passive: true } as const
  const activityEvents = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'input', 'scroll'] as const
  activityEvents.forEach(e => window.addEventListener(e, activity, opts))
  window.addEventListener('pointermove', onMove, opts)
  document.addEventListener('selectionchange', activity)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', flush)
  const t1 = setInterval(tick, TICK_MS)
  const t2 = setInterval(flush, SAVE_MS)

  return () => {
    clearInterval(t1); clearInterval(t2)
    activityEvents.forEach(e => window.removeEventListener(e, activity, opts))
    window.removeEventListener('pointermove', onMove, opts)
    document.removeEventListener('selectionchange', activity)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flush)
    flush()
  }
}
