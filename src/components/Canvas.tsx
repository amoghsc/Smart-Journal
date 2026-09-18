import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, NodeResizer, Panel, applyNodeChanges, useReactFlow,
  type Node, type NodeChange, type NodeProps, type NodeTypes,
} from '@xyflow/react'
import { ExternalLink, FilePlus, StickyNote, FileOutput, Palette } from 'lucide-react'
import { useStore } from '../lib/store'
import type { CanvasItem, Page } from '../lib/types'
import { Preview } from './Preview'
import { PagePicker } from './PagePicker'

type PageNodeT = Node<{ pageId: string }, 'page'>
type StickyNodeT = Node<{ text: string; color: string | null }, 'sticky'>
type CanvasNode = PageNodeT | StickyNodeT

const COLORS = [null, '#f5c451', '#7fd1ae', '#8fb8ff', '#f19bb5', '#c9a7f5']

interface CanvasCtx {
  openPage: (title: string) => void
  setText: (id: string, text: string) => void
  cycleColor: (id: string) => void
  resized: (id: string, w: number, h: number, x: number, y: number) => void
}
const Ctx = createContext<CanvasCtx>(null!)

function PageNode({ id, data, selected }: NodeProps<PageNodeT>) {
  const { byId } = useStore()
  const ctx = useContext(Ctx)
  const page = byId.get(data.pageId)
  return (
    <div className={'card page-card' + (selected ? ' selected' : '')} onDoubleClick={() => page && ctx.openPage(page.title)}>
      <NodeResizer minWidth={180} minHeight={90} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle"
        onResizeEnd={(_, p) => ctx.resized(id, p.width, p.height, p.x, p.y)} />
      <div className="card-head">
        <span className="card-title">{page?.title ?? '(deleted page)'}</span>
        {page && <button className="card-open nodrag" title="Open in editor" onClick={() => ctx.openPage(page.title)}><ExternalLink size={14} /></button>}
      </div>
      <div className="card-body nowheel">
        {page ? (page.body ? <Preview body={page.body} onNavigate={ctx.openPage} className="small" /> : <span className="muted">Empty page</span>) : null}
      </div>
    </div>
  )
}

function StickyNode({ id, data, selected }: NodeProps<StickyNodeT>) {
  const ctx = useContext(Ctx)
  const [text, setText] = useState(data.text)
  useEffect(() => setText(data.text), [data.text])
  return (
    <div className={'card sticky' + (selected ? ' selected' : '')} style={data.color ? { background: data.color, color: '#1a1400' } : undefined}>
      <NodeResizer minWidth={140} minHeight={80} isVisible={selected} lineClassName="rz-line" handleClassName="rz-handle"
        onResizeEnd={(_, p) => ctx.resized(id, p.width, p.height, p.x, p.y)} />
      <button className="card-color nodrag" title="Colour" onClick={() => ctx.cycleColor(id)}><Palette size={14} /></button>
      <textarea
        className="nodrag nowheel"
        value={text}
        placeholder="Sticky note…"
        onChange={e => { setText(e.target.value); ctx.setText(id, e.target.value) }}
      />
    </div>
  )
}

const nodeTypes: NodeTypes = { page: PageNode, sticky: StickyNode }

function toNode(it: CanvasItem): CanvasNode {
  const base = { id: it.id, position: { x: it.x, y: it.y }, width: it.w, height: it.h }
  return it.page_id
    ? { ...base, type: 'page', data: { pageId: it.page_id } }
    : { ...base, type: 'sticky', data: { text: it.text ?? '', color: it.color } }
}

interface Props {
  canvas: Page
  onOpenPage: (title: string) => void
}

/** Infinite canvas of page cards and stickies, persisted per item. Must be inside <ReactFlowProvider>. */
export function Canvas({ canvas, onOpenPage }: Props) {
  const store = useStore()
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [picker, setPicker] = useState(false)
  const [loading, setLoading] = useState(true)
  const wrap = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    let live = true
    setLoading(true)
    store.loadItems(canvas.id).then(items => { if (live) { setNodes(items.map(toNode)); setLoading(false) } }).catch(console.error)
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.id])

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes(ns => applyNodeChanges(changes, ns))
    const removed: string[] = []
    for (const c of changes) {
      if (c.type === 'position' && c.position && !c.dragging) store.updateItem(c.id, { x: c.position.x, y: c.position.y })
      if (c.type === 'remove') removed.push(c.id)
    }
    if (removed.length) store.deleteItems(removed).catch(console.error)
  }, [store])

  const centre = () => {
    const r = wrap.current?.getBoundingClientRect()
    const p = screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 })
    // jitter so repeated adds don't stack exactly
    return { x: Math.round(p.x - 130 + (Math.random() - 0.5) * 60), y: Math.round(p.y - 80 + (Math.random() - 0.5) * 60) }
  }

  const addPage = async (title: string) => {
    setPicker(false)
    const page = await store.ensurePage(title)
    const { x, y } = centre()
    const it = await store.addItem({ canvas_id: canvas.id, page_id: page.id, text: null, x, y, w: 280, h: 180, color: null })
    setNodes(ns => [...ns, toNode(it)])
  }

  const addSticky = async () => {
    const { x, y } = centre()
    const it = await store.addItem({ canvas_id: canvas.id, page_id: null, text: '', x, y, w: 200, h: 120, color: '#f5c451' })
    setNodes(ns => [...ns, { ...toNode(it), selected: true }])
  }

  const selectedCount = nodes.filter(n => n.selected).length
  const compile = async () => {
    const ordered = nodes.filter(n => n.selected).sort((a, b) => Math.round(a.position.y / 60) - Math.round(b.position.y / 60) || a.position.x - b.position.x)
    const parts: string[] = []
    for (const n of ordered) {
      if (n.type === 'page') { const p = store.byId.get(n.data.pageId); if (p) parts.push(`<h2>${p.title}</h2>${p.body}`) }
      else if (n.data.text.trim()) parts.push(`<p>${n.data.text.trim().replace(/\n/g, '<br>')}</p>`)
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const title = `Draft — ${canvas.title} — ${stamp}`
    await store.ensurePage(title)
    store.setBody(title, `<p><em>Compiled from canvas ${canvas.title}</em></p>${parts.join('')}`)
    onOpenPage(title)
  }

  const ctx = useMemo<CanvasCtx>(() => ({
    openPage: onOpenPage,
    setText: (id, text) => { store.updateItem(id, { text }); setNodes(ns => ns.map(n => n.id === id && n.type === 'sticky' ? { ...n, data: { ...n.data, text } } : n)) },
    cycleColor: id => setNodes(ns => ns.map(n => {
      if (n.id !== id || n.type !== 'sticky') return n
      const color = COLORS[(COLORS.indexOf(n.data.color) + 1) % COLORS.length]
      store.updateItem(id, { color })
      return { ...n, data: { ...n.data, color } }
    })),
    resized: (id, w, h, x, y) => store.updateItem(id, { w, h, x, y }),
  }), [onOpenPage, store])

  return (
    <Ctx.Provider value={ctx}>
      <div className="canvas" ref={wrap}>
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          maxZoom={2.5}
          panOnScroll
          selectionOnDrag={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
          <Panel position="top-left" className="canvas-tools">
            <button className="btn small" onClick={() => setPicker(true)}><FilePlus size={16} /> Page</button>
            <button className="btn small" onClick={addSticky}><StickyNote size={16} /> Sticky</button>
            <button className="btn small" onClick={compile} disabled={!selectedCount} title="Combine the selected cards (shift-click or shift-drag to select several), top to bottom, into one new note"><FileOutput size={16} /> Compile{selectedCount > 1 ? ` (${selectedCount})` : ''}</button>
          </Panel>
          {!loading && nodes.length === 0 && (
            <Panel position="top-center" className="canvas-empty">Empty canvas — add a page or a sticky, then drag things around.</Panel>
          )}
        </ReactFlow>
      </div>
      {picker && <PagePicker title="Add page to canvas" onPick={addPage} onClose={() => setPicker(false)} />}
    </Ctx.Provider>
  )
}
