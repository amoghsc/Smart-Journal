import { supabase } from './supabase'

/**
 * Report crashes and unhandled errors to nt_client_errors, so a problem seen once can be diagnosed
 * without reproducing it. Messages and stack traces only — never note contents.
 */

const MAX_PER_SESSION = 20
let sent = 0
const recent = new Set<string>()

export function reportError(kind: 'render' | 'error' | 'rejection', err: unknown, componentStack?: string) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
  const key = `${kind}:${e.message}`
  if (sent >= MAX_PER_SESSION || recent.has(key)) return
  recent.add(key); sent++
  console.error('[journal]', kind, e, componentStack ?? '')
  supabase.from('nt_client_errors').insert({
    kind,
    message: e.message.slice(0, 1000),
    stack: e.stack?.slice(0, 4000) ?? null,
    component_stack: componentStack?.slice(0, 4000) ?? null,
    url: location.pathname + location.hash.split('/').slice(0, 2).join('/'),   // no note titles
    user_agent: navigator.userAgent.slice(0, 300),
    build: __BUILD__,
  }).then(() => {}, () => {})
}

/** Errors outside React (event handlers, timers, promises) don't blank the screen, but are worth knowing about. */
export function watchGlobalErrors() {
  window.addEventListener('error', e => { if (e.error) reportError('error', e.error) })
  window.addEventListener('unhandledrejection', e => reportError('rejection', e.reason))
}
