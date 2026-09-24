import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../lib/errors'

interface State { error: Error | null; showDetails: boolean }

/** Instead of a blank page: say what happened, keep the details, and offer a reload that returns to the same note. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError('render', error, info.componentStack ?? undefined)
  }

  render() {
    const { error, showDetails } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>Your saved notes are safe. Reloading brings you back to the note you were on.</p>
        <p className="muted small">Anything typed in the last second or so may not have been saved.</p>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
          <button className="btn" onClick={() => this.setState({ showDetails: !showDetails })}>{showDetails ? 'Hide details' : 'Details'}</button>
        </div>
        {showDetails && <pre className="crash-details">{error.message}{'\n\n'}{error.stack}</pre>}
      </div>
    )
  }
}
