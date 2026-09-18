import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { CanvasItem, Page, PageKind } from './types'
import { isDailyTitle, normTitle } from './links'
import { extractLinks, relinkTitle, unlinkTitle } from './html'

interface Store {
  session: Session | null
  ready: boolean
  pages: Page[]
  byId: Map<string, Page>
  /** lower-cased title → page */
  byTitle: Map<string, Page>
  /** lower-cased title → ids of pages that link to it */
  backlinks: Map<string, string[]>
  getPage: (title: string) => Page | undefined
  /** Create the page if it does not exist yet (awaits the insert so the id is usable as a foreign key). */
  ensurePage: (title: string, kind?: PageKind) => Promise<Page>
  /** Optimistic body update; creates the page on first edit; debounced write + link sync. */
  setBody: (title: string, body: string) => void
  /** Local-only page shown in a pane; becomes real on the first title/body edit, discarded otherwise. */
  createDraft: (title: string) => Page
  discardDraft: (id: string) => void
  renamePage: (id: string, title: string) => Promise<void>
  deletePage: (id: string) => Promise<void>
  reload: () => Promise<void>
  loadItems: (canvasId: string) => Promise<CanvasItem[]>
  addItem: (item: Omit<CanvasItem, 'id'>) => Promise<CanvasItem>
  updateItem: (id: string, patch: Partial<CanvasItem>) => void
  deleteItems: (ids: string[]) => Promise<void>
}

const Ctx = createContext<Store | null>(null)
export const useStore = () => {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}

const SAVE_DELAY = 700

export function StoreProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [pages, setPages] = useState<Page[]>([])

  // latest local state, readable synchronously from debounced writers
  const latest = useRef(new Map<string, Page>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const writers = useRef(new Map<string, () => Promise<void>>())

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('nt_pages').select('id,title,kind,body,created_at,updated_at').order('updated_at', { ascending: false })
    if (error) { console.error(error); return }
    const rows = (data ?? []) as Page[]
    // keep local versions of pages that still have a pending save
    const merged = rows.map(r => timers.current.has(r.id) ? latest.current.get(r.id) ?? r : r)
    for (const [id, p] of latest.current) if ((timers.current.has(id) || p.draft) && !merged.some(m => m.id === id)) merged.push(p)
    latest.current = new Map(merged.map(p => [p.id, p]))
    setPages(merged)
  }, [])

  useEffect(() => {
    if (!session) { setPages([]); return }
    reload()
    const onVis = () => { if (document.visibilityState === 'visible') reload(); else flushAll() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flushAll)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', flushAll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reload])

  // live updates from other devices (skips rows this device is still saving)
  useEffect(() => {
    if (!session) return
    const ch = supabase.channel('nt-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nt_pages' }, payload => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (!id) return
          latest.current.delete(id)
          setPages(prev => prev.filter(p => p.id !== id))
          return
        }
        const row = payload.new as Page
        if (timers.current.has(row.id)) return
        const cur = latest.current.get(row.id)
        if (cur && cur.updated_at >= row.updated_at && cur.body === row.body && cur.title === row.title) return
        upsertLocal(row)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  function schedule(key: string, fn: () => Promise<void>) {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    writers.current.set(key, fn)
    timers.current.set(key, setTimeout(() => flush(key), SAVE_DELAY))
  }
  function flush(key: string) {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    timers.current.delete(key)
    const fn = writers.current.get(key)
    writers.current.delete(key)
    fn?.().catch(e => console.error('save failed', key, e))
  }
  function flushAll() { for (const k of [...timers.current.keys()]) flush(k) }

  const byId = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages])
  const byTitle = useMemo(() => new Map(pages.map(p => [normTitle(p.title), p])), [pages])
  const backlinks = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of pages) for (const t of extractLinks(p.body)) m.set(t, [...(m.get(t) ?? []), p.id])
    return m
  }, [pages])

  const getPage = useCallback((title: string) => byTitle.get(normTitle(title)), [byTitle])

  function upsertLocal(p: Page) {
    latest.current.set(p.id, p)
    setPages(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? p : x) : [p, ...prev])
  }

  async function writePage(id: string) {
    const p = latest.current.get(id)
    if (!p) return
    if (p.draft) return
    const { error } = await supabase.from('nt_pages').upsert({ id: p.id, title: p.title, kind: p.kind, body: p.body, updated_at: p.updated_at })
    if (error) {
      // 23505 = another device already created this title; take theirs and retry the body onto it
      if (error.code === '23505') { await reload(); const other = latest.current.get(id) ?? [...latest.current.values()].find(x => normTitle(x.title) === normTitle(p.title)); if (other && other.id !== id) { latest.current.set(other.id, { ...other, body: p.body }); await writePage(other.id); setPages(prev => prev.filter(x => x.id !== id)) } return }
      throw error
    }
    const links = extractLinks(p.body)
    await supabase.from('nt_links').delete().eq('from_page', p.id)
    if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
  }

  const ensurePage = useCallback(async (title: string, kind?: PageKind) => {
    const existing = byTitle.get(normTitle(title)) ?? [...latest.current.values()].find(p => normTitle(p.title) === normTitle(title))
    if (existing) return existing
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), title: title.trim(), kind: kind ?? (isDailyTitle(title) ? 'daily' : 'note'), body: '', created_at: now, updated_at: now }
    upsertLocal(p)
    const { error } = await supabase.from('nt_pages').insert({ id: p.id, title: p.title, kind: p.kind, body: '' })
    if (error) { await reload(); const again = latest.current.get(p.id) ?? [...latest.current.values()].find(x => normTitle(x.title) === normTitle(title)); if (again) return again; throw error }
    return p
  }, [byTitle, reload])

  const setBody = useCallback((title: string, body: string) => {
    const now = new Date().toISOString()
    const existing = byTitle.get(normTitle(title)) ?? [...latest.current.values()].find(p => normTitle(p.title) === normTitle(title))
    const p: Page = existing
      ? { ...existing, body, updated_at: now, draft: false }
      : { id: crypto.randomUUID(), title: title.trim(), kind: isDailyTitle(title) ? 'daily' : 'note', body, created_at: now, updated_at: now }
    upsertLocal(p)
    schedule(p.id, () => writePage(p.id))
  }, [byTitle])

  const createDraft = useCallback((title: string) => {
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), title: title.trim(), kind: 'note', body: '', created_at: now, updated_at: now, draft: true }
    upsertLocal(p)
    return p
  }, [])

  const discardDraft = useCallback((id: string) => {
    const p = latest.current.get(id)
    if (!p?.draft) return
    latest.current.delete(id)
    setPages(prev => prev.filter(x => x.id !== id))
  }, [])

  const renamePage = useCallback(async (id: string, title: string) => {
    const clash = byTitle.get(normTitle(title))
    if (clash && clash.id !== id) throw new Error(`A note called “${clash.title}” already exists`)
    const p = latest.current.get(id) ?? byId.get(id)
    if (!p) return
    const kind: PageKind = isDailyTitle(title) ? 'daily' : p.kind === 'daily' ? 'note' : p.kind
    const next: Page = { ...p, title: title.trim(), kind, draft: false }
    upsertLocal(next)
    const { error } = await supabase.from('nt_pages').upsert({ id: next.id, title: next.title, kind: next.kind, body: next.body, updated_at: next.updated_at })
    if (error) throw error
    // links elsewhere follow the page to its new name
    for (const lid of backlinks.get(normTitle(p.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id) setBody(l.title, relinkTitle(l.body, p.title, next.title))
    }
  }, [byTitle, byId, backlinks, setBody])

  const deletePage = useCallback(async (id: string) => {
    const gone = latest.current.get(id) ?? byId.get(id)
    timers.current.delete(id); writers.current.delete(id); latest.current.delete(id)
    setPages(prev => prev.filter(p => p.id !== id))
    const { error } = await supabase.from('nt_pages').delete().eq('id', id)
    if (error) throw error
    // words that linked to the deleted page become plain text again
    if (gone) for (const lid of backlinks.get(normTitle(gone.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id) setBody(l.title, unlinkTitle(l.body, gone.title))
    }
  }, [byId, backlinks, setBody])

  // ---- canvas items ----
  const loadItems = useCallback(async (canvasId: string) => {
    const { data, error } = await supabase.from('nt_canvas_items').select('id,canvas_id,page_id,text,x,y,w,h,color').eq('canvas_id', canvasId)
    if (error) throw error
    return (data ?? []) as CanvasItem[]
  }, [])

  const items = useRef(new Map<string, CanvasItem>())

  const addItem = useCallback(async (item: Omit<CanvasItem, 'id'>) => {
    const full: CanvasItem = { ...item, id: crypto.randomUUID() }
    items.current.set(full.id, full)
    const { error } = await supabase.from('nt_canvas_items').insert(full)
    if (error) throw error
    return full
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    const cur = items.current.get(id)
    items.current.set(id, { ...(cur ?? { id }), ...patch } as CanvasItem)
    schedule('item:' + id, async () => {
      const it = items.current.get(id)
      if (!it) return
      const { error } = await supabase.from('nt_canvas_items').update({ ...patch, ...pick(it, Object.keys(patch) as (keyof CanvasItem)[]), updated_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    })
  }, [])

  const deleteItems = useCallback(async (ids: string[]) => {
    for (const id of ids) { items.current.delete(id); timers.current.delete('item:' + id); writers.current.delete('item:' + id) }
    const { error } = await supabase.from('nt_canvas_items').delete().in('id', ids)
    if (error) throw error
  }, [])

  const value: Store = { session, ready, pages, byId, byTitle, backlinks, getPage, ensurePage, setBody, createDraft, discardDraft, renamePage, deletePage, reload, loadItems, addItem, updateItem, deleteItems }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) out[k] = o[k]
  return out
}
