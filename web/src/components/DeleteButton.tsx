import { useState } from 'react'

import { api } from '../api'
import { useBasket } from '../basket'

/** Deletes takes for good (their files and their entry), after a second click to confirm. */
export function DeleteButton({ ids, label = 'Delete', compact = false, onDeleted }: {
  ids: string[]
  label?: string
  compact?: boolean
  onDeleted: (ids: string[]) => void
}) {
  const basket = useBasket()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    const gone: string[] = []
    for (const id of ids) {
      try {
        await api.remove(id)
        gone.push(id)
        basket.remove(id)
      } catch (e) {
        setError((e as Error).message)
      }
    }
    setBusy(false)
    setAsking(false)
    if (gone.length) onDeleted(gone)
  }

  if (!asking)
    return (
      <>
        <button type="button" className={compact ? 'icon-link' : 'button button--small button--outline'}
          title="Delete for good" aria-label={label} onClick={() => setAsking(true)}>
          {compact ? 'Delete' : label}
        </button>
        {error && <span className="error">{error}</span>}
      </>
    )
  return (
    <span className="confirm-inline" role="alertdialog" aria-label="Confirm delete">
      <span className="meta-label">Delete for good?</span>
      <button type="button" className="button button--small" disabled={busy} onClick={confirm}>{busy ? 'Deleting…' : 'Delete'}</button>
      <button type="button" className="button button--small button--outline" onClick={() => setAsking(false)}>Keep</button>
    </span>
  )
}
