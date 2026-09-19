import { useEffect, useState } from 'react'

import { api, fileName, isLoop, previewUrl, type Take } from '../api'
import { exportZip, useBasket } from '../basket'
import { Player } from './Player'

/** The takes picked for export; the zip has one folder per sound with its file and a .json. */
export function Basket({ onClose }: { onClose: () => void }) {
  const basket = useBasket()
  const [takes, setTakes] = useState<Take[] | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const key = basket.ids.join()
  useEffect(() => {
    let alive = true
    Promise.all(key.split(',').filter(Boolean).map((id) => api.take(id).catch(() => null))).then((ts) => {
      if (alive) setTakes(ts.filter((t): t is Take => !!t && t.status === 'completed'))
    })
    return () => {
      alive = false
    }
  }, [key])

  async function download() {
    if (!takes?.length) return
    setError(null)
    setProgress(0)
    try {
      const zip = await exportZip(takes, setProgress)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(zip)
      a.download = 'game-audio.zip'
      a.click()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
    }
  }

  return (
    <aside className="drawer" aria-label="Basket">
      <div className="drawer__head">
        <h2 className="drawer__title">Basket</h2>
        <button type="button" className="button button--small button--outline" onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        The sounds you picked with Add to basket. Export makes a zip with one folder per sound, holding the
        Godot file and a .json describing it (e.g. sfx/footsteps_01/footsteps_01.wav and footsteps_01.json).
      </p>
      <button type="button" className="button button--wide" disabled={!takes?.length || progress !== null} onClick={download}>
        {progress !== null ? `Packing ${progress}/${takes?.length}…` : `Export ${takes?.length ?? 0} as .zip`}
      </button>
      {error && <p className="error">{error}</p>}
      {takes && !takes.length && <p className="hint">Empty. Press Add to basket on any sound to add it.</p>}
      <ul className="drawer__list">
        {takes?.map((t) => (
          <li key={t.id} className="drawer__item">
            <Player url={previewUrl(t)} loop={isLoop(t)} compact />
            <span className="drawer__name">{t.kind}/{t.name}/{fileName(t)}</span>
            <span />
            <button type="button" className="icon-link" onClick={() => basket.remove(t.id)} title="Remove from the basket">Remove</button>
          </li>
        ))}
      </ul>
      {!!takes?.length && (
        <button type="button" className="button button--small button--outline" onClick={basket.clear}>Empty the basket</button>
      )}
    </aside>
  )
}
