import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { CanvasItem, Page, PageKind, Vault, VaultKind } from './types'
import { isDailyTitle, normTitle } from './links'
import { extractLinks, relinkTitle, unlinkTitle } from './html'

const PAGE_COLS = 'id,vault_id,title,kind,body,draft,active_seconds,created_at,updated_at'

interface Store {
  session: Session | null
  ready: boolean
  /** Every page in every vault. */
  allPages: Page[]
  /** Pages in the current vault. */
  pages: Page[]
  vaults: Vault[]
  vault: Vault | null
  setVault: (id: string) => void
  byId: Map<string, Page>
  /** lower-cased title → page, within the current vault */
  byTitle: Map<string, Page>
  /** lower-cased title → ids of pages that link to it, within the current vault */
  backlinks: Map<string, string[]>
  getPage: (title: string) => Page | undefined
  pagesIn: (vaultId: string) => Page[]
  /** Create the page if it does not exist yet (awaits the insert so the id is usable as a foreign key). */
  ensurePage: (title: string, kind?: PageKind) => Promise<Page>
  /** Optimistic body update; creates the page on first edit; debounced write + link sync. */
  setBody: (title: string, body: string) => void
  /** Local-only page shown in a pane; becomes real on the first title/body edit, discarded otherwise. */
  createLocal: (title: string) => Page
  discardLocal: (id: string) => void
  renamePage: (id: string, title: string) => Promise<void>
  deletePage: (id: string) => Promise<void>
  setDraft: (id: string, draft: boolean) => Promise<void>
  copyPages: (ids: string[], vaultId: string) => Promise<number>
  /** Add time spent to a note (atomic on the server; does not change updated_at). */
  addTime: (id: string, seconds: number) => Promise<void>
  createVault: (name: string, kind: VaultKind) => Promise<Vault>
  updateVault: (id: string, patch: Partial<Vault>) => Promise<void>
  deleteVault: (id: string) => Promise<void>
  reload: () => Promise<void>
  /** Write pending edits now and wait for them. */
  saveNow: () => Promise<void>
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
  const [allPages, setAllPages] = useState<Page[]>([])
  const [vaults, setVaults] = useState<Vault[]>([])
  const [vaultId, setVaultId] = useState<string | null>(() => localStorage.getItem('vault'))

  // latest local state, readable synchronously from debounced writers
  const latest = useRef(new Map<string, Page>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const writers = useRef(new Map<string, () => Promise<void>>())
  const inflight = useRef(new Set<string>())   // notes whose save is on its way to the server

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const reload = useCallback(async () => {
    const [v, p] = await Promise.all([
      supabase.from('nt_vaults').select('*').order('sort_order').order('created_at'),
      supabase.from('nt_pages').select(PAGE_COLS).order('updated_at', { ascending: false }),
    ])
    if (v.error) { console.error(v.error); return }
    if (p.error) { console.error(p.error); return }
    setVaults((v.data ?? []) as Vault[])
    const rows = (p.data ?? []) as Page[]
    // keep local versions of pages that still have a pending save
    const merged = rows.map(r => (timers.current.has(r.id) || inflight.current.has(r.id)) ? latest.current.get(r.id) ?? r : r)
    for (const [id, pg] of latest.current) if ((timers.current.has(id) || pg.local) && !merged.some(m => m.id === id)) merged.push(pg)
    latest.current = new Map(merged.map(pg => [pg.id, pg]))
    setAllPages(merged)
  }, [])

  useEffect(() => {
    if (!session) { setAllPages([]); setVaults([]); return }
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
          setAllPages(prev => prev.filter(p => p.id !== id))
          return
        }
        // Update messages can leave fields out: Postgres omits large unchanged values (a long note's body)
        // from them. So never take the message as the whole note — merge only the fields it carries.
        const row = payload.new as Partial<Page> & { id: string }
        if (!row?.id || timers.current.has(row.id) || inflight.current.has(row.id)) return
        const present = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as Partial<Page>
        const cur = latest.current.get(row.id)
        if (!cur) {
          if (typeof row.body === 'string' && typeof row.title === 'string') upsertLocal(row as Page)
          else fetchPage(row.id)   // new to us and incomplete: read the whole row
          return
        }
        const textChanged = (present.body !== undefined && present.body !== cur.body) || (present.title !== undefined && present.title !== cur.title)
        if (!textChanged || (present.updated_at && present.updated_at < cur.updated_at)) {
          // only the time spent (or nothing we show) changed — e.g. another device, or our own save echoing back
          if ((present.active_seconds ?? 0) > (cur.active_seconds ?? 0)) upsertLocal({ ...cur, active_seconds: present.active_seconds })
          return
        }
        upsertLocal({ ...cur, ...present })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nt_vaults' }, () => { reload() })
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
    return fn?.().catch(e => console.error('save failed', key, e))
  }
  function flushAll() { for (const k of [...timers.current.keys()]) flush(k) }
  /** Write everything still waiting for its debounce, and wait for it (used before a reload). */
  const saveNow = useCallback(async () => { await Promise.all([...timers.current.keys()].map(k => flush(k))) }, [])

  // the current vault: remembered, else the first private one, else the first
  const vault = useMemo(() => {
    if (!vaults.length) return null
    return vaults.find(v => v.id === vaultId) ?? vaults.find(v => v.kind === 'private') ?? vaults[0]
  }, [vaults, vaultId])
  useEffect(() => { if (vault) localStorage.setItem('vault', vault.id) }, [vault])
  const setVault = useCallback((id: string) => setVaultId(id), [])

  const pages = useMemo(() => vault ? allPages.filter(p => p.vault_id === vault.id) : [], [allPages, vault])
  const pagesIn = useCallback((id: string) => allPages.filter(p => p.vault_id === id), [allPages])

  const byId = useMemo(() => new Map(allPages.map(p => [p.id, p])), [allPages])
  const byTitle = useMemo(() => new Map(pages.map(p => [normTitle(p.title), p])), [pages])
  const backlinks = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of pages) for (const t of extractLinks(p.body)) m.set(t, [...(m.get(t) ?? []), p.id])
    return m
  }, [pages])

  const getPage = useCallback((title: string) => byTitle.get(normTitle(title)), [byTitle])

  async function fetchPage(id: string) {
    const { data, error } = await supabase.from('nt_pages').select(PAGE_COLS).eq('id', id).maybeSingle()
    if (!error && data && !timers.current.has(id)) upsertLocal(data as Page)
  }

  function upsertLocal(p: Page) {
    latest.current.set(p.id, p)
    setAllPages(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? p : x) : [p, ...prev])
  }

  const row = (p: Page) => ({ id: p.id, vault_id: p.vault_id, title: p.title, kind: p.kind, body: p.body, draft: p.draft ?? false, updated_at: p.updated_at })

  async function writePage(id: string) {
    inflight.current.add(id)
    try { await writePageNow(id) } finally { inflight.current.delete(id) }
  }

  async function writePageNow(id: string) {
    const p = latest.current.get(id)
    if (!p) return
    if (p.local) return
    const { error } = await supabase.from('nt_pages').upsert(row(p))
    if (error) {
      // 23505 = another device already created this title in this vault; take theirs and retry the body onto it
      if (error.code === '23505') {
        await reload()
        const other = [...latest.current.values()].find(x => x.vault_id === p.vault_id && normTitle(x.title) === normTitle(p.title) && x.id !== id)
        if (other) { latest.current.set(other.id, { ...other, body: p.body }); await writePage(other.id); setAllPages(prev => prev.filter(x => x.id !== id)) }
        return
      }
      throw error
    }
    const links = extractLinks(p.body)
    await supabase.from('nt_links').delete().eq('from_page', p.id)
    if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
  }

  const findLocal = useCallback((title: string) =>
    vault ? [...latest.current.values()].find(p => p.vault_id === vault.id && normTitle(p.title) === normTitle(title)) : undefined, [vault])

  const ensurePage = useCallback(async (title: string, kind?: PageKind) => {
    if (!vault) throw new Error('No vault selected')
    const existing = byTitle.get(normTitle(title)) ?? findLocal(title)
    if (existing) return existing
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), vault_id: vault.id, title: title.trim(), kind: kind ?? (isDailyTitle(title) ? 'daily' : 'note'), body: '', created_at: now, updated_at: now }
    upsertLocal(p)
    const { error } = await supabase.from('nt_pages').insert(row(p))
    if (error) { await reload(); const again = findLocal(title); if (again) return again; throw error }
    return p
  }, [vault, byTitle, findLocal, reload])

  const setBody = useCallback((title: string, body: string) => {
    if (!vault) return
    const now = new Date().toISOString()
    const existing = byTitle.get(normTitle(title)) ?? findLocal(title)
    const p: Page = existing
      ? { ...existing, body, updated_at: now, local: false }
      : { id: crypto.randomUUID(), vault_id: vault.id, title: title.trim(), kind: isDailyTitle(title) ? 'daily' : 'note', body, created_at: now, updated_at: now }
    upsertLocal(p)
    schedule(p.id, () => writePage(p.id))
  }, [vault, byTitle, findLocal])

  const createLocal = useCallback((title: string) => {
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), vault_id: vault?.id ?? '', title: title.trim(), kind: 'note', body: '', created_at: now, updated_at: now, local: true }
    upsertLocal(p)
    return p
  }, [vault])

  const discardLocal = useCallback((id: string) => {
    const p = latest.current.get(id)
    if (!p?.local) return
    latest.current.delete(id)
    setAllPages(prev => prev.filter(x => x.id !== id))
  }, [])

  const renamePage = useCallback(async (id: string, title: string) => {
    const clash = byTitle.get(normTitle(title))
    if (clash && clash.id !== id) throw new Error(`A note called “${clash.title}” already exists in this vault`)
    const p = latest.current.get(id) ?? byId.get(id)
    if (!p) return
    const kind: PageKind = isDailyTitle(title) ? 'daily' : p.kind === 'daily' ? 'note' : p.kind
    const next: Page = { ...p, title: title.trim(), kind, local: false }
    upsertLocal(next)
    const { error } = await supabase.from('nt_pages').upsert(row(next))
    if (error) throw error
    // links elsewhere follow the page to its new name
    for (const lid of backlinks.get(normTitle(p.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id && typeof l.body === 'string') setBody(l.title, relinkTitle(l.body, p.title, next.title))
    }
  }, [byTitle, byId, backlinks, setBody])

  const deletePage = useCallback(async (id: string) => {
    const gone = latest.current.get(id) ?? byId.get(id)
    timers.current.delete(id); writers.current.delete(id); latest.current.delete(id)
    setAllPages(prev => prev.filter(p => p.id !== id))
    const { error } = await supabase.from('nt_pages').delete().eq('id', id)
    if (error) throw error
    // words that linked to the deleted page become plain text again
    if (gone) for (const lid of backlinks.get(normTitle(gone.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id && typeof l.body === 'string') setBody(l.title, unlinkTitle(l.body, gone.title))
    }
  }, [byId, backlinks, setBody])

  const setDraft = useCallback(async (id: string, draft: boolean) => {
    const p = latest.current.get(id) ?? byId.get(id)
    if (!p) return
    upsertLocal({ ...p, draft })
    const { error } = await supabase.from('nt_pages').update({ draft }).eq('id', id)
    if (error) throw error
  }, [byId])

  /**
   * Copy notes into another vault. The originals stay where they are. A note whose title already exists
   * in the target vault replaces that copy's text (so copying again brings a published copy up to date).
   */
  const copyPages = useCallback(async (ids: string[], target: string) => {
    const now = new Date().toISOString()
    const inTarget = (title: string) => [...latest.current.values()].find(x => x.vault_id === target && !x.local && normTitle(x.title) === normTitle(title))
    const out: Page[] = []
    for (const id of ids) {
      const src = latest.current.get(id) ?? byId.get(id)
      if (!src || src.vault_id === target) continue
      const existing = inTarget(src.title)
      out.push(existing
        ? { ...existing, body: src.body, kind: src.kind, updated_at: now }
        : { id: crypto.randomUUID(), vault_id: target, title: src.title, kind: src.kind, body: src.body, created_at: now, updated_at: now, draft: false })
    }
    if (!out.length) return 0
    const { error } = await supabase.from('nt_pages').upsert(out.map(row))
    if (error) throw error
    for (const p of out) upsertLocal(p)
    for (const p of out) {
      const links = extractLinks(p.body)
      await supabase.from('nt_links').delete().eq('from_page', p.id)
      if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
    }
    return out.length
  }, [byId])

  const addTime = useCallback(async (id: string, seconds: number) => {
    const { data, error } = await supabase.rpc('nt_add_time', { page: id, secs: seconds })
    if (error) throw error
    const p = latest.current.get(id)
    if (p && typeof data === 'number') upsertLocal({ ...p, active_seconds: data })
  }, [])

  // ---- vaults ----
  const createVault = useCallback(async (name: string, kind: VaultKind) => {
    const v: Vault = {
      id: crypto.randomUUID(), name: name.trim(), kind,
      site_title: kind === 'public' ? name.trim() : null, site_description: null, site_author: null, site_url: null,
      sort_order: vaults.length, created_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('nt_vaults').insert(v)
    if (error) throw error
    setVaults(prev => [...prev, v])
    return v
  }, [vaults.length])

  const updateVault = useCallback(async (id: string, patch: Partial<Vault>) => {
    setVaults(prev => prev.map(v => v.id === id ? { ...v, ...patch } : v))
    const { error } = await supabase.from('nt_vaults').update(patch).eq('id', id)
    if (error) throw error
  }, [])

  const deleteVault = useCallback(async (id: string) => {
    const { error } = await supabase.from('nt_vaults').delete().eq('id', id)
    if (error) throw error
    setVaults(prev => prev.filter(v => v.id !== id))
    setAllPages(prev => prev.filter(p => p.vault_id !== id))
    setVaultId(null)
  }, [])

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

  const value: Store = {
    session, ready, allPages, pages, vaults, vault, setVault, byId, byTitle, backlinks, getPage, pagesIn,
    ensurePage, setBody, createLocal, discardLocal, renamePage, deletePage, setDraft, copyPages, addTime,
    createVault, updateVault, deleteVault, reload, saveNow, loadItems, addItem, updateItem, deleteItems,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) out[k] = o[k]
  return out
}
