import { useEffect, useState } from 'react'

import { api, fileName, fileUrl, isLoop, previewUrl, type Take } from '../api'
import { useBasket } from '../basket'
import { DeleteButton } from './DeleteButton'
import { Player } from './Player'

const FOLDERS = { sfx: 'Sound effects', music: 'Music', voice: 'Voice' } as const

/** Saved sounds, shared by everyone on the site. Export goes through the basket. */
export function Library({ onClose, onChange, onDeleted }: {
  onClose: () => void
  onChange: (t: Take) => void
  onDeleted: (ids: string[]) => void
}) {
  const [takes, setTakes] = useState<Take[] | null>(null)
  const basket = useBasket()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.library().then(setTakes).catch((e) => setError((e as Error).message))
  }, [])

  async function unsave(t: Take) {
    const updated = await api.update(t.id, { saved: false })
    setTakes((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
    onChange(updated)
  }

  return (
    <aside className="drawer" aria-label="Library">
      <div className="drawer__head">
        <h2 className="drawer__title">Library</h2>
        <button type="button" className="button button--small button--outline" onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        Sounds you saved with Save, kept until you remove them. To download several at once, add them to the
        basket and export it from there.
      </p>
      <button type="button" className="button button--wide" disabled={!takes?.length}
        onClick={() => takes && basket.add(takes.map((t) => t.id))}>
        Add all {takes?.length ?? 0} to the basket
      </button>
      {error && <p className="error">{error}</p>}
      {takes && !takes.length && <p className="hint">Nothing saved yet. Press Save on a sound you like.</p>}
      {(Object.keys(FOLDERS) as (keyof typeof FOLDERS)[]).map((kind) => {
        const list = takes?.filter((t) => t.kind === kind) ?? []
        if (!list.length) return null
        return (
          <section key={kind} className="drawer__group">
            <h3 className="meta-label">{FOLDERS[kind]} · {list.length}</h3>
            <ul>
              {list.map((t) => (
                <li key={t.id} className="drawer__item">
                  <Player url={previewUrl(t)} loop={isLoop(t)} compact />
                  <span className="drawer__name">{fileName(t)}</span>
                  <a className="icon-link" href={fileUrl(t)} download={fileName(t)} title="Download for Godot">Download</a>
                  <button type="button" className={`icon-link${basket.has(t.id) ? ' is-on' : ''}`} onClick={() => basket.toggle(t.id)}
                    title={basket.has(t.id) ? 'In the basket (click to remove)' : 'Add to the basket'}>{basket.has(t.id) ? 'In basket' : 'Basket'}</button>
                  <button type="button" className="icon-link" onClick={() => unsave(t)} title="Remove from the Library (keeps the sound for 7 days)">Unsave</button>
                  <DeleteButton ids={[t.id]} compact onDeleted={(ids) => {
                    setTakes((ts) => ts?.filter((x) => !ids.includes(x.id)) ?? null)
                    onDeleted(ids)
                  }} />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </aside>
  )
}
