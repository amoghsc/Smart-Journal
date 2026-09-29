import { strToU8, zipSync } from 'fflate'
import { noteToMarkdown } from './export'
import { wordStats } from './html'
import { formatDuration } from './activeTime'
import { isDailyTitle, prettyDate } from './links'
import type { Page, Vault } from './types'

/**
 * A copy of every note in a folder on this device, kept up to date every few minutes — so the notes are yours even
 * if the cloud copy is lost. One Markdown file per note, laid out like the app:
 *
 *   <folder>/<Vault>/Journal/2026/2026-09-28.md
 *   <folder>/<Vault>/Notes/<Title>.md
 *
 * Each file starts with a small block of details (Markdown "front matter": grey in Obsidian, Typora and the like,
 * plain lines in any text editor), then the note in Markdown: **bold**, *italic*, ~~struck~~, ==highlight==, lists,
 * [links](…) and [[note links]]. Files are only ever added or updated: a note deleted in the app moves to
 * <Vault>/_Deleted/, so a mistake (or someone else) emptying the cloud can't empty the backup too.
 *
 * Writing to a folder needs the File System Access API (Chrome, Edge, Arc, Brave, Opera on a computer). Elsewhere
 * (Safari, Firefox, phones) the same files come as a .zip to download.
 */

export const BACKUP_EVENT = 'nt-backup'
export const BACKUP_EVERY_MS = 3 * 60_000

type Handle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

export const canBackUpToFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

// ---- a little IndexedDB store: the folder (a handle can't go in localStorage) and what was written where ----

const DB = 'smart-journal-backup'
function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode)
      const req = f(tx.objectStore('kv'))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => open.result.close()
    }
  })
}
const get = <T>(k: string) => idb<T | undefined>('readonly', s => s.get(k))
const put = (k: string, v: unknown) => idb<void>('readwrite', s => s.put(v, k))
const del = (k: string) => idb<void>('readwrite', s => s.delete(k))

/** What was last written for each note: its path (folders + file) and a fingerprint of the contents. */
type Manifest = Record<string, { path: string[]; hash: string; vault: string }>

export interface BackupStatus { folder: string | null; on: boolean; last: number | null; needsPermission: boolean; error: string | null; writing: boolean }
let status: BackupStatus = { folder: null, on: false, last: null, needsPermission: false, error: null, writing: false }
const announce = (patch: Partial<BackupStatus>) => { status = { ...status, ...patch }; window.dispatchEvent(new CustomEvent(BACKUP_EVENT, { detail: status })) }
export const backupStatus = () => status

export async function loadBackupState() {
  const h = await get<Handle>('dir').catch(() => undefined)
  const last = Number(localStorage.getItem('backup-last')) || null
  let needsPermission = false
  if (h?.queryPermission) needsPermission = (await h.queryPermission({ mode: 'readwrite' })) !== 'granted'
  announce({ folder: h?.name ?? null, on: !!h, last, needsPermission })
}

/** Pick the folder to back up into (asks the browser for permission to write there). */
export async function chooseBackupFolder(): Promise<boolean> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<Handle> }).showDirectoryPicker
  let h: Handle
  try { h = await pick({ id: 'smart-journal-backup', mode: 'readwrite', startIn: 'documents' }) }
  catch { return false }   // cancelled
  await put('dir', h)
  await del('manifest')
  announce({ folder: h.name, on: true, needsPermission: false, error: null })
  return true
}

export async function stopBackup() {
  await del('dir'); await del('manifest')
  localStorage.removeItem('backup-last')
  announce({ folder: null, on: false, last: null, needsPermission: false, error: null })
}

/** After a restart the browser may ask again before writing; this must run from a click. */
export async function resumeBackup(): Promise<boolean> {
  const h = await get<Handle>('dir')
  if (!h?.requestPermission) return false
  const ok = (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
  announce({ needsPermission: !ok })
  return ok
}

// ---- the files ----

const safe = (s: string) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled')
const yaml = (s: string) => (/^[\w .,'()&+-]*$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s))

function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36) + s.length.toString(36)
}

/** Where a note lives in the backup: [vault, Journal|Notes, (year), file]. */
export function notePath(p: Page, vault: Vault): string[] {
  const v = safe(vault.name)
  return isDailyTitle(p.title) ? [v, 'Journal', p.title.slice(0, 4), `${p.title}.md`] : [v, 'Notes', `${safe(p.title)}.md`]
}

/** The file: details first (front matter), then the note as Markdown. */
export function noteFile(p: Page, vault: Vault): string {
  const daily = isDailyTitle(p.title)
  const title = daily ? prettyDate(p.title) : p.title
  const { words } = wordStats(p.body)
  const time = formatDuration(p.active_seconds ?? 0)
  const meta = [
    '---',
    `title: ${yaml(title)}`,
    `vault: ${yaml(vault.name)}`,
    `type: ${daily ? 'journal' : 'note'}`,
    daily ? `date: ${p.title}` : null,
    `created: ${p.created_at}`,
    `updated: ${p.updated_at}`,
    `words: ${words}`,
    time ? `time_spent: ${yaml(time)}` : null,
    vault.kind === 'public' ? `published: ${p.draft ? 'no (held back)' : 'yes'}` : null,
    `id: ${p.id}`,
    '---',
    '',
  ].filter(l => l != null)
  return meta.join('\n') + noteToMarkdown(title, p.body)
}

async function dirAt(root: FileSystemDirectoryHandle, parts: string[]) {
  let d = root
  for (const part of parts) d = await d.getDirectoryHandle(part, { create: true })
  return d
}
async function writeFile(root: FileSystemDirectoryHandle, path: string[], text: string) {
  const dir = await dirAt(root, path.slice(0, -1))
  const f = await dir.getFileHandle(path[path.length - 1], { create: true })
  const w = await f.createWritable()
  await w.write(text)
  await w.close()
}
async function readFile(root: FileSystemDirectoryHandle, path: string[]): Promise<string | null> {
  try {
    let d = root
    for (const part of path.slice(0, -1)) d = await d.getDirectoryHandle(part)
    return await (await (await d.getFileHandle(path[path.length - 1])).getFile()).text()
  } catch { return null }
}
async function removeFile(root: FileSystemDirectoryHandle, path: string[]) {
  try {
    let d = root
    for (const part of path.slice(0, -1)) d = await d.getDirectoryHandle(part)
    await d.removeEntry(path[path.length - 1])
  } catch { /* already gone */ }
}

const README = `This folder is a backup of your Smart Journal notes, kept up to date by the app every few minutes while it's open.

Each vault has a folder: Journal/ holds your days (a folder per year), Notes/ everything else.
One Markdown (.md) file per note: any text editor opens it; Obsidian, Typora, iA Writer and the like show its formatting.
Nothing here is ever deleted by the app: a note deleted in Smart Journal moves to its vault's _Deleted/ folder.
`

let running = false

/**
 * Bring the backup up to date: write notes that are new or changed, move renamed ones, set deleted ones aside.
 * Returns how many files were written; quietly does nothing when no folder is set or permission is needed.
 */
export async function runBackup(pages: Page[], vaults: Vault[]): Promise<number> {
  if (running) return 0
  const h = await get<Handle>('dir').catch(() => undefined)
  if (!h) return 0
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') { announce({ needsPermission: true }); return 0 }
  running = true
  announce({ writing: true, error: null })
  let written = 0
  try {
    const manifest = (await get<Manifest>('manifest')) ?? {}
    const byVault = new Map(vaults.map(v => [v.id, v]))
    if (!Object.keys(manifest).length) await writeFile(h, ['README.txt'], README)
    const seen = new Set<string>()
    for (const p of pages) {
      const vault = byVault.get(p.vault_id)
      if (!vault || p.local || p.kind === 'canvas') continue
      seen.add(p.id)
      const path = notePath(p, vault), text = noteFile(p, vault), fp = hash(text)
      const before = manifest[p.id]
      if (before && before.hash === fp && before.path.join('/') === path.join('/')) continue
      // two notes that come out with the same file name: the second gets its id's start added
      const clash = Object.entries(manifest).some(([id, m]) => id !== p.id && m.path.join('/').toLowerCase() === path.join('/').toLowerCase())
      if (clash) path[path.length - 1] = path[path.length - 1].replace(/\.md$/, ` (${p.id.slice(0, 6)}).md`)
      await writeFile(h, path, text)
      // renamed or moved: the old file goes (its note is in the new one)
      if (before && before.path.join('/') !== path.join('/')) await removeFile(h, before.path)
      manifest[p.id] = { path, hash: fp, vault: vault.name }
      written++
    }
    // deleted in the app: kept, in the vault's _Deleted folder
    for (const [id, m] of Object.entries(manifest)) {
      if (seen.has(id)) continue
      const text = await readFile(h, m.path)
      if (text != null) {
        await writeFile(h, [m.path[0], '_Deleted', m.path[m.path.length - 1]], text)
        await removeFile(h, m.path)
      }
      delete manifest[id]
    }
    await put('manifest', manifest)
    const now = Date.now()
    localStorage.setItem('backup-last', String(now))
    announce({ last: now, writing: false })
  } catch (e) {
    announce({ error: (e as Error).message, writing: false })
  } finally { running = false }
  return written
}

/** Every note as a .zip laid out the same way (for browsers that can't write to a folder). */
export function backupZip(pages: Page[], vaults: Vault[]): Blob {
  const byVault = new Map(vaults.map(v => [v.id, v]))
  const files: Record<string, Uint8Array> = { 'Smart Journal/README.txt': strToU8(README) }
  for (const p of pages) {
    const vault = byVault.get(p.vault_id)
    if (!vault || p.local || p.kind === 'canvas') continue
    let path = ['Smart Journal', ...notePath(p, vault)].join('/')
    if (files[path]) path = path.replace(/\.md$/, ` (${p.id.slice(0, 6)}).md`)
    files[path] = strToU8(noteFile(p, vault))
  }
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'application/zip' })
}
