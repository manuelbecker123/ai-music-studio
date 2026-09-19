import { zipSync } from 'fflate'
import { useEffect, useState } from 'react'

import { api, fileName, fileUrl, isLoop, previewUrl, type Take } from '../api'
import { Player } from './Player'

const FOLDERS = { sfx: 'Sound effects', music: 'Music', voice: 'Voice' } as const

/** Saved sounds, shared by everyone on the site, with a zip laid out for res://audio/. */
export function Library({ onClose, onChange }: { onClose: () => void; onChange: (t: Take) => void }) {
  const [takes, setTakes] = useState<Take[] | null>(null)
  const [zipping, setZipping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.library().then(setTakes).catch((e) => setError((e as Error).message))
  }, [])

  async function unsave(t: Take) {
    const updated = await api.update(t.id, { saved: false })
    setTakes((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
    onChange(updated)
  }

  async function downloadAll() {
    if (!takes?.length) return
    setZipping(true)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const t of takes) {
        const data = new Uint8Array(await (await fetch(fileUrl(t))).arrayBuffer())
        files[`${t.kind}/${fileName(t)}`] = data
      }
      const zip = zipSync(files, { level: 0 }) // audio is already compressed or tiny
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }))
      a.download = 'game-audio.zip'
      a.click()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setZipping(false)
    }
  }

  return (
    <aside className="drawer" aria-label="Library">
      <div className="drawer__head">
        <h2 className="drawer__title">Library</h2>
        <button type="button" className="button button--small button--outline" onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        Sounds you saved with ☆, kept until you remove them. The zip has sfx/, music/ and voice/ folders:
        unzip it into your Godot project's res://audio/.
      </p>
      <button type="button" className="button button--wide" disabled={!takes?.length || zipping} onClick={downloadAll}>
        {zipping ? 'Packing…' : `⬇ Download all (${takes?.length ?? 0}) as .zip`}
      </button>
      {error && <p className="error">{error}</p>}
      {takes && !takes.length && <p className="hint">Nothing saved yet. Press ☆ Save on a sound you like.</p>}
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
                  <a className="icon-link" href={fileUrl(t)} download={fileName(t)} title="Download for Godot">⬇</a>
                  <button type="button" className="icon-link" onClick={() => unsave(t)} title="Remove from the Library">★</button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </aside>
  )
}
