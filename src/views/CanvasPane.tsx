import { useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { LayoutGrid, Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { Canvas } from '../components/Canvas'

interface Props {
  canvasId: string | null
  onSelectCanvas: (id: string) => void
  onOpenPage: (title: string) => void
}

/** Canvas chooser + the canvas itself. */
export function CanvasPane({ canvasId, onSelectCanvas, onOpenPage }: Props) {
  const { pages, ensurePage } = useStore()
  const canvases = pages.filter(p => p.kind === 'canvas').sort((a, b) => a.title.localeCompare(b.title))
  const canvas = canvases.find(c => c.id === canvasId) ?? null
  const [busy, setBusy] = useState(false)

  // first load: pick the most recent canvas if none chosen
  useEffect(() => {
    if (!canvas && canvases.length) onSelectCanvas(canvases[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, canvases.length])

  const create = async () => {
    const title = window.prompt('Canvas name', canvases.length ? '' : 'Ideas')
    if (!title?.trim()) return
    setBusy(true)
    try {
      const p = await ensurePage(title.trim(), 'canvas')
      onSelectCanvas(p.id)
    } finally { setBusy(false) }
  }

  return (
    <div className="pane canvas-pane">
      <div className="pane-head">
        <div className="pane-title canvas-title">
          <LayoutGrid size={18} />
          {canvases.length > 0 ? (
            <select value={canvas?.id ?? ''} onChange={e => onSelectCanvas(e.target.value)}>
              {canvases.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          ) : <h2>Canvas</h2>}
        </div>
        <div className="pane-actions">
          <button className="btn small" onClick={create} disabled={busy}><Plus size={16} /> New canvas</button>
        </div>
      </div>
      {canvas ? (
        <ReactFlowProvider key={canvas.id}>
          <Canvas canvas={canvas} onOpenPage={onOpenPage} />
        </ReactFlowProvider>
      ) : (
        <div className="center-screen canvas-blank">
          <LayoutGrid size={40} className="muted" />
          <p className="muted">A canvas is a spatial view of your pages: drop notes on it, move them around, keep related things together.</p>
          <button className="btn primary" onClick={create} disabled={busy}>Create your first canvas</button>
        </div>
      )}
    </div>
  )
}
