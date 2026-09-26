/** An on/off switch styled like iOS's, for a settings row: the whole row toggles it. */
export function SwitchRow({ label, hint, on, onChange, disabled }: { label: string; hint?: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={'menu-row switch-row' + (disabled ? ' disabled' : '')} title={hint}
      disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-label">{label}</span>
      <span className={'switch' + (on ? ' on' : '')} aria-hidden><span className="switch-knob" /></span>
    </button>
  )
}
