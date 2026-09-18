import { useMemo } from 'react'
import { sanitize } from '../lib/html'

interface Props {
  body: string
  onNavigate: (title: string) => void
  className?: string
}

/** Read-only render of a page body (used by canvas cards); wikilink clicks navigate. */
export function Preview({ body, onNavigate, className }: Props) {
  const html = useMemo(() => sanitize(body), [body])
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    const wl = t.closest<HTMLElement>('.wikilink')
    if (wl?.dataset.title) { e.preventDefault(); e.stopPropagation(); onNavigate(wl.dataset.title); return }
    const a = t.closest<HTMLAnchorElement>('a[href]')
    if (a) { e.preventDefault(); e.stopPropagation(); window.open(a.href, '_blank', 'noopener') }
  }
  return <div className={'note ' + (className ?? '')} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
