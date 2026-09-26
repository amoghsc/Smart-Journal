import { useEffect, useRef, useState } from 'react'
import { FileDown, FileText, FileType, Hash, Printer } from 'lucide-react'
import { download, fileName, noteToDocx, noteToMarkdown, noteToText, printNote } from '../lib/export'
import { toast } from '../lib/toast'

/** Export this note: PDF (print window), Word (opens in Pages too), Markdown or plain text. */
export function ExportMenu({ title, html }: { title: string; html: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const run = async (what: 'pdf' | 'docx' | 'md' | 'txt') => {
    setOpen(false)
    try {
      setBusy(true)
      if (what === 'pdf') printNote(title, html)
      if (what === 'docx') download(fileName(title, 'docx'), await noteToDocx(title, html))
      if (what === 'md') download(fileName(title, 'md'), noteToMarkdown(title, html), 'text/markdown;charset=utf-8')
      if (what === 'txt') download(fileName(title, 'txt'), noteToText(title, html))
    } catch (e) { toast('Couldn’t export this note', (e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="move" ref={box}>
      <button className={'icon-btn' + (open ? ' on' : '')} title="Export this note" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(o => !o)}>
        <FileDown size={16} />
      </button>
      {open && (
        <div className="move-menu" role="menu">
          <div className="move-head">Export as</div>
          <button role="menuitem" className="move-row" onClick={() => run('pdf')} title="Opens the print window: choose “Save as PDF”"><Printer size={13} /><span className="move-name">PDF</span></button>
          <button role="menuitem" className="move-row" onClick={() => run('docx')} title="A Word document; Pages opens it too"><FileType size={13} /><span className="move-name">Word · Pages</span></button>
          <button role="menuitem" className="move-row" onClick={() => run('md')} title="Markdown, with note links as [[Title]] (Obsidian-style)"><Hash size={13} /><span className="move-name">Markdown</span></button>
          <button role="menuitem" className="move-row" onClick={() => run('txt')}><FileText size={13} /><span className="move-name">Plain text</span></button>
        </div>
      )}
    </div>
  )
}
