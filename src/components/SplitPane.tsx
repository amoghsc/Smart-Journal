import { useRef, useState, type ReactNode } from 'react'

interface Props {
  left: ReactNode
  right: ReactNode
  storageKey: string
  min?: number
  /** Animate the left pane shut (its content may be null while collapsed). */
  collapsed?: boolean
}

/** Two panes side by side with a draggable divider (mouse + touch); ratio persisted in localStorage. */
export function SplitPane({ left, right, storageKey, min = 0.2, collapsed = false }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    const v = Number(localStorage.getItem(storageKey))
    return v > 0 && v < 1 ? v : 0.45
  })
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !box.current) return
    const r = box.current.getBoundingClientRect()
    setRatio(Math.min(1 - min, Math.max(min, (e.clientX - r.left) / r.width)))
  }
  const onPointerUp = () => {
    setDragging(false)
    localStorage.setItem(storageKey, String(ratio))
  }

  return (
    <div ref={box} className={'split' + (dragging ? ' dragging' : '') + (collapsed ? ' collapsed' : '')}>
      <div className="split-left" style={{ flexBasis: collapsed ? 0 : `${ratio * 100}%` }}>{left}</div>
      {!collapsed && <div className="split-divider" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />}
      <div className="split-right">{right}</div>
    </div>
  )
}
