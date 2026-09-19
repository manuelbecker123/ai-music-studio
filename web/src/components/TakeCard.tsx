import { useState } from 'react'

import { api, fileName, fileUrl, isLoop, previewUrl, type Take } from '../api'
import { useBasket } from '../basket'
import { Editor } from './Editor'
import { Player } from './Player'

type Props = {
  takes: Take[] // one take, or the versions of one sound effect
  now: number
  onChange: (t: Take) => void
  onCreated: (ts: Take[]) => void
  onRetryVoice: (t: Take) => void
}

function Status({ t, now }: { t: Take; now: number }) {
  if (t.status === 'failed') return <span className="meta-label status status--failed">Failed</span>
  if (t.status === 'completed') return null
  const secs = Math.max(0, Math.round(now / 1000 - t.created_at))
  return (
    <span className="meta-label status">
      {t.status === 'queued' ? 'Waiting' : 'Making it'} · {secs} s
    </span>
  )
}

function Name({ t, onChange }: { t: Take; onChange: (t: Take) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(t.name)
  const save = async () => {
    setEditing(false)
    if (value.trim() && value !== t.name) onChange(await api.update(t.id, { name: value }).catch(() => t))
    else setValue(t.name)
  }
  return editing ? (
    <input
      className="input name-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label="File name"
    />
  ) : (
    <button type="button" className="name" onClick={() => setEditing(true)} title="Rename (this becomes the file name)">
      {t.name} <span aria-hidden>✎</span>
    </button>
  )
}

function SaveButton({ t, onChange }: { t: Take; onChange: (t: Take) => void }) {
  return (
    <button
      type="button"
      className={`button button--small button--outline${t.saved ? ' is-on' : ''}`}
      aria-pressed={t.saved}
      title="Saved sounds stay in the Library; everything else is deleted after 7 days"
      onClick={async () => onChange(await api.update(t.id, { saved: !t.saved }).catch(() => t))}
    >
      {t.saved ? '★ Saved' : '☆ Save'}
    </button>
  )
}

function BasketButton({ t }: { t: Take }) {
  const basket = useBasket()
  const on = basket.has(t.id)
  return (
    <button type="button" className={`button button--small button--outline${on ? ' is-on' : ''}`} aria-pressed={on}
      title="Pick this sound for the next export" onClick={() => basket.toggle(t.id)}>
      {on ? '✓ In basket' : '+ Basket'}
    </button>
  )
}

function Intensity({ t, onCreated }: { t: Take; onCreated: (ts: Take[]) => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button type="button" className="button button--small button--outline"
        title="A calmer version with the same tempo and length: play it while exploring and switch to this one for action"
        onClick={async () => {
          try {
            onCreated(await api.create({ parent_id: t.id, intensity: true }))
          } catch (e) {
            setError((e as Error).message)
          }
        }}>
        ⇅ Calm version
      </button>
      {error && <p className="error">{error}</p>}
    </>
  )
}

function MoreLikeThis({ t, onCreated }: { t: Take; onCreated: (ts: Take[]) => void }) {
  const [open, setOpen] = useState(false)
  const [difference, setDifference] = useState(0.4)
  const [error, setError] = useState<string | null>(null)
  if (!open)
    return (
      <button type="button" className="button button--small button--outline" onClick={() => setOpen(true)}
        title="Make a new version that starts from this one">
        ↻ More like this
      </button>
    )
  return (
    <div className="more">
      <label className="more__slider">
        <span className="meta-label">Similar</span>
        <input className="range" type="range" min={0} max={1} step={0.05} value={difference}
          onChange={(e) => setDifference(Number(e.target.value))} aria-label="How different" />
        <span className="meta-label">Different</span>
      </label>
      <div className="more__actions">
        <button type="button" className="button button--small" onClick={async () => {
          try {
            onCreated(await api.create({ parent_id: t.id, difference }))
            setOpen(false)
          } catch (e) {
            setError((e as Error).message)
          }
        }}>Make it</button>
        <button type="button" className="button button--small button--outline" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Actions({ t, onChange, onCreated, onRetryVoice }: Omit<Props, 'takes' | 'now'> & { t: Take }) {
  const [editing, setEditing] = useState(false)
  if (editing) return <Editor take={t} onCreated={onCreated} onClose={() => setEditing(false)} />
  return (
    <div className="card__actions">
      <a className="button button--small" href={fileUrl(t)} download={fileName(t)}
        title={t.game_ext === 'ogg' ? 'OGG file, ready for Godot' : 'WAV file, ready for Godot'}>
        ⬇ For Godot
      </a>
      <BasketButton t={t} />
      <SaveButton t={t} onChange={onChange} />
      {!isLoop(t) && (
        <button type="button" className="button button--small button--outline" onClick={() => setEditing(true)}
          title="Cut the start or end, add fades">✂ Trim</button>
      )}
      {t.profile === 'music' && !t.intensity && <Intensity t={t} onCreated={onCreated} />}
      {t.kind === 'voice' || t.song ? (
        <button type="button" className="button button--small button--outline" onClick={() => onRetryVoice(t)}
          title="Make it again; every take comes out a little different">
          ↻ Another take
        </button>
      ) : (
        <MoreLikeThis t={t} onCreated={onCreated} />
      )}
    </div>
  )
}

// The model's own length tag is misleading here: loops are generated longer, then cut.
const described = (t: Take) => t.revised_prompt?.replace(/\s*Length:\s*[\d.]+\s*seconds?\.?/i, '').trim()

export function TakeCard({ takes, now, onChange, onCreated, onRetryVoice }: Props) {
  const first = takes[0]
  const group = takes.length > 1
  const done = takes.filter((t) => t.status === 'completed')
  const label = first.kind === 'voice' ? `“${first.prompt}”` : first.prompt

  return (
    <li className="card">
      <div className="card__head">
        <span className="meta-label">
          {first.kind === 'sfx' ? 'Sound effect' : first.song ? 'Song' : first.kind === 'music' ? 'Music' : 'Voice'}
          {first.edited ? ' · trimmed' : first.intensity ? ' · intensity versions' : first.parent_id ? ' · more like this' : ''}
          {group && !first.intensity ? ` · ${takes.length} versions` : ''}
        </span>
        {!group && <Status t={first} now={now} />}
      </div>
      <p className="card__prompt">{label}</p>
      {first.lyrics && <pre className="card__lyrics">{first.lyrics}</pre>}
      {described(first) && described(first) !== first.prompt && (
        <p className="card__revised" title="What the model was actually told, after the prompt helper rewrote your words">
          {described(first)}
        </p>
      )}

      {group ? (
        <ul className="versions">
          {takes.map((t, i) => (
            <li key={t.id} className="version">
              <span className="meta-label">{t.intensity ?? i + 1}</span>
              {t.status === 'completed' ? <Player url={previewUrl(t)} loop={isLoop(t)} compact /> : <Status t={t} now={now} />}
              <Name t={t} onChange={onChange} />
              {t.status === 'completed' && <BasketButton t={t} />}
              {t.status === 'completed' && <SaveButton t={t} onChange={onChange} />}
              {t.error && <span className="error">{t.error.message}</span>}
            </li>
          ))}
        </ul>
      ) : (
        first.status === 'completed' && (
          <>
            <Player url={previewUrl(first)} loop={isLoop(first)} />
            <Name t={first} onChange={onChange} />
          </>
        )
      )}

      {!group && first.error && <p className="error">{first.error.message}</p>}
      {!group && first.status === 'completed' && (
        <Actions t={first} onChange={onChange} onCreated={onCreated} onRetryVoice={onRetryVoice} />
      )}
      {group && done.length === takes.length && (
        <div className="card__actions">
          <button type="button" className="button button--small" onClick={() => done.forEach((t, i) => {
            setTimeout(() => {
              const a = document.createElement('a')
              a.href = fileUrl(t)
              a.download = fileName(t)
              a.click()
            }, i * 400)
          })}>
            ⬇ All {takes.length} for Godot
          </button>
          {!first.intensity && <MoreLikeThis t={first} onCreated={onCreated} />}
        </div>
      )}
      {first.status === 'completed' && isLoop(first) && (
        <p className="hint">In Godot: select the file, open the Import tab, tick Loop, then Reimport.</p>
      )}
    </li>
  )
}
