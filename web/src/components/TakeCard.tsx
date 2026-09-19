import { useState } from 'react'

import { api, fileName, fileUrl, isLoop, previewUrl, type Take } from '../api'
import { useBasket } from '../basket'
import { DELIVERY, LANGUAGES } from '../catalog'
import { DeleteButton } from './DeleteButton'
import { Editor } from './Editor'
import { Player } from './Player'

type Props = {
  takes: Take[] // one take, or the versions of one sound effect
  now: number
  onChange: (t: Take) => void
  onCreated: (ts: Take[]) => void
  onRetryVoice: (t: Take) => void
  onDeleted: (ids: string[]) => void
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
    <button type="button" className="name" onClick={() => setEditing(true)} title="Click to rename (this becomes the file name)">
      {t.name}
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
      {t.saved ? 'Saved' : 'Save'}
    </button>
  )
}

function BasketButton({ t }: { t: Take }) {
  const basket = useBasket()
  const on = basket.has(t.id)
  return (
    <button type="button" className={`button button--small button--outline${on ? ' is-on' : ''}`} aria-pressed={on}
      title="Pick this sound for the next export" onClick={() => basket.toggle(t.id)}>
      {on ? 'In basket' : 'Add to basket'}
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
        Calm version
      </button>
      {error && <p className="error">{error}</p>}
    </>
  )
}

const DIRECTION_EXAMPLES = {
  sfx: 'e.g. more metallic, shorter tail, deeper',
  music: 'e.g. slower, add a flute melody, darker mood',
  song: 'e.g. more upbeat, male voice, add drums',
}

/** Refine a take. Sounds, music and songs start from their own audio: how far it may move, plus
 * an optional direction. Voice lines are remade in the same voice with edited words and delivery. */
function RefinePanel({ t, onCreated, onClose }: { t: Take; onCreated: (ts: Take[]) => void; onClose: () => void }) {
  const [difference, setDifference] = useState(0.4)
  const [direction, setDirection] = useState('')
  const [line, setLine] = useState(t.prompt)
  const [delivery, setDelivery] = useState(t.delivery ?? 0.5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const voice = t.kind === 'voice'

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.create(voice
        ? { parent_id: t.id, line, delivery }
        : { parent_id: t.id, difference, ...(direction.trim() ? { direction: direction.trim() } : {}) }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="refine">
      {voice ? (
        <>
          <label className="control">
            <span className="meta-label">Line</span>
            <textarea className="textarea textarea--short" value={line} onChange={(e) => setLine(e.target.value)} maxLength={500} />
          </label>
          <div className="control">
            <span className="meta-label">Delivery</span>
            <div className="chips chips--small" role="radiogroup" aria-label="Delivery">
              {DELIVERY.map((d) => (
                <button key={d.label} type="button" role="radio" aria-checked={delivery === d.value} onClick={() => setDelivery(d.value)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">Change the words or the feeling; it is spoken again in the same voice.</p>
        </>
      ) : (
        <>
          <label className="refine__slider">
            <span className="meta-label">Similar</span>
            <input className="range" type="range" min={0} max={1} step={0.05} value={difference}
              onChange={(e) => setDifference(Number(e.target.value))} aria-label="How different" />
            <span className="meta-label">Different</span>
          </label>
          <label className="control">
            <span className="meta-label">Direction (optional)</span>
            <input className="input input--text" value={direction} onChange={(e) => setDirection(e.target.value)} maxLength={300}
              placeholder={DIRECTION_EXAMPLES[t.song ? 'song' : t.kind === 'music' ? 'music' : 'sfx']} />
          </label>
          <p className="hint">
            Starts from this sound. Leave the direction empty for a variation; name a change to push it that way.
            Further towards Different lets it change more.
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="card__actions">
        <button type="button" className="button button--small" disabled={busy || (voice && !line.trim())} onClick={submit}>
          {busy ? 'Sending…' : 'Refine'}
        </button>
        <button type="button" className="button button--small button--outline" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

function Actions({ t, onChange, onCreated, onRetryVoice, onDeleted }: Omit<Props, 'takes' | 'now'> & { t: Take }) {
  const [panel, setPanel] = useState<'trim' | 'refine' | null>(null)
  if (panel === 'trim') return <Editor take={t} onCreated={onCreated} onClose={() => setPanel(null)} />
  if (panel === 'refine') return <RefinePanel t={t} onCreated={onCreated} onClose={() => setPanel(null)} />
  return (
    <div className="card__actions">
      <a className="button button--small" href={fileUrl(t)} download={fileName(t)}
        title={t.game_ext === 'ogg' ? 'OGG file, ready for Godot' : 'WAV file, ready for Godot'}>
        For Godot
      </a>
      <BasketButton t={t} />
      <SaveButton t={t} onChange={onChange} />
      <button type="button" className="button button--small button--outline" onClick={() => setPanel('refine')}
        title={t.kind === 'voice' ? 'Change the words or the delivery' : 'Make a new version from this one, optionally in a direction'}>
        Refine
      </button>
      {!isLoop(t) && (
        <button type="button" className="button button--small button--outline" onClick={() => setPanel('trim')}
          title="Cut the start or end, add fades">Trim</button>
      )}
      {t.profile === 'music' && !t.intensity && <Intensity t={t} onCreated={onCreated} />}
      {(t.kind === 'voice' || t.song) && (
        <button type="button" className="button button--small button--outline" onClick={() => onRetryVoice(t)}
          title="Make it again; every take comes out a little different">
          Another take
        </button>
      )}
      <DeleteButton ids={[t.id]} onDeleted={onDeleted} />
    </div>
  )
}

// The model's own length tag is misleading here: loops are generated longer, then cut.
const described = (t: Take) => t.revised_prompt?.replace(/\s*Length:\s*[\d.]+\s*seconds?\.?/i, '').trim()

export function TakeCard({ takes, now, onChange, onCreated, onRetryVoice, onDeleted }: Props) {
  const [refining, setRefining] = useState<Take | null>(null)
  const first = takes[0]
  const group = takes.length > 1
  const done = takes.filter((t) => t.status === 'completed')
  const label = first.kind === 'voice' ? `“${first.prompt}”` : first.prompt

  return (
    <li className="card">
      <div className="card__head">
        <span className="meta-label">
          {first.kind === 'sfx' ? 'Sound effect' : first.song ? 'Song' : first.kind === 'music' ? 'Music' : 'Voice'}
          {first.edited ? ' · trimmed' : first.intensity ? ' · intensity versions' : first.parent_id ? ' · refined' : ''}
          {group && !first.intensity ? ` · ${takes.length} versions` : ''}
        </span>
        {!group && <Status t={first} now={now} />}
      </div>
      <p className="card__prompt">{label}</p>
      {first.lyrics && <pre className="card__lyrics">{first.lyrics}</pre>}
      {first.kind === 'voice' && first.translate_to && first.revised_prompt ? (
        <p className="card__revised">Spoken in {LANGUAGES[first.translate_to]}: “{first.revised_prompt}”</p>
      ) : described(first) && described(first) !== first.prompt && (
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
              <div className="version__actions">
                {t.status === 'completed' && <BasketButton t={t} />}
                {t.status === 'completed' && <SaveButton t={t} onChange={onChange} />}
                {t.status === 'completed' && !t.intensity && (
                  <button type="button" className={`button button--small button--outline${refining?.id === t.id ? ' is-on' : ''}`}
                    onClick={() => setRefining(refining?.id === t.id ? null : t)}>Refine</button>
                )}
                {t.status !== 'in_progress' && <DeleteButton ids={[t.id]} compact onDeleted={onDeleted} />}
                {t.error && <span className="error">{t.error.message}</span>}
              </div>
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
        <Actions t={first} onChange={onChange} onCreated={onCreated} onRetryVoice={onRetryVoice} onDeleted={onDeleted} />
      )}
      {group && refining && (
        <>
          <p className="meta-label">Refining {refining.name}</p>
          <RefinePanel t={refining} onCreated={onCreated} onClose={() => setRefining(null)} />
        </>
      )}
      {group && !refining && done.length === takes.length && (
        <div className="card__actions">
          <button type="button" className="button button--small" onClick={() => done.forEach((t, i) => {
            setTimeout(() => {
              const a = document.createElement('a')
              a.href = fileUrl(t)
              a.download = fileName(t)
              a.click()
            }, i * 400)
          })}>
            All {takes.length} for Godot
          </button>
          <DeleteButton ids={takes.map((t) => t.id)} label={`Delete all ${takes.length}`} onDeleted={onDeleted} />
        </div>
      )}
      {!group && (first.status === 'failed' || first.status === 'queued') && (
        <div className="card__actions"><DeleteButton ids={[first.id]} onDeleted={onDeleted} /></div>
      )}
      {first.status === 'completed' && isLoop(first) && (
        <p className="hint">In Godot: select the file, open the Import tab, tick Loop, then Reimport.</p>
      )}
    </li>
  )
}
