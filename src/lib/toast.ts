/** A short confirmation at the bottom of the screen. */
let timer: ReturnType<typeof setTimeout> | null = null

export function toast(message: string, detail?: string) {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    document.body.appendChild(el)
  }
  el.replaceChildren()
  const strong = document.createElement('span')
  strong.className = 'toast-msg'
  strong.textContent = message
  el.appendChild(strong)
  if (detail) {
    const small = document.createElement('span')
    small.className = 'toast-detail'
    small.textContent = detail
    el.appendChild(small)
  }
  el.classList.add('show')
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => el!.classList.remove('show'), detail ? 3500 : 2200)
}

/** Clipboard write with a fallback for browsers that refuse the async API. */
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return }
  catch { /* fall back below */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}
