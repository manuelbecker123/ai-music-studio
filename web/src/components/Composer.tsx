import { useState } from 'react'

import { api, type NewTake, type Take, type Voice } from '../api'
import {
  DEFAULT_VOICE_LABEL, LANGUAGES, LIMITS, MUSIC_EXAMPLE, MUSIC_LENGTHS, SFX_CATEGORIES, VOICE_EXAMPLE, sfxCategory,
  type Kind,
} from '../catalog'

const TABS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'sfx', label: 'Sound effects', hint: 'Short sounds: steps, hits, spells, clicks, creatures, backgrounds.' },
  { kind: 'music', label: 'Music', hint: 'Background music for a level or a menu.' },
  { kind: 'voice', label: 'Voice', hint: 'Spoken lines for characters.' },
]

type Props = {
  voices: Voice[]
  onCreated: (ts: Take[]) => void
  onRecordVoice: () => void
}

function Chips<T extends string | number>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="hint">{children}</p>
}

export function Composer({ voices, onCreated, onRecordVoice }: Props) {
  const [kind, setKind] = useState<Kind>('sfx')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  // sound effects
  const [category, setCategory] = useState('footsteps')
  const [sfxPrompt, setSfxPrompt] = useState('')
  const [versions, setVersions] = useState<1 | 4>(4)
  const [sfxSeconds, setSfxSeconds] = useState<number | ''>('')
  // music
  const [musicPrompt, setMusicPrompt] = useState('')
  const [length, setLength] = useState(30)
  const [loop, setLoop] = useState(true)
  // voice
  const [line, setLine] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [delivery, setDelivery] = useState(0.5)
  const [language, setLanguage] = useState('en')
  // shared "more options"
  const [exactWords, setExactWords] = useState(false)
  const [seed, setSeed] = useState('')

  const cat = sfxCategory(category)!
  const tab = TABS.find((t) => t.kind === kind)!

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const shared = { enhance: !exactWords, ...(seed.trim() ? { seed: Number(seed) } : {}) }
    let body: NewTake
    if (kind === 'sfx') {
      body = { kind, category, prompt: sfxPrompt || cat.example, versions: cat.loop ? 1 : versions, ...shared,
               ...(sfxSeconds !== '' ? { seconds: sfxSeconds } : {}) }
    } else if (kind === 'music') {
      body = { kind, prompt: musicPrompt || MUSIC_EXAMPLE, seconds: length, loop, ...shared }
    } else {
      body = { kind, prompt: line || VOICE_EXAMPLE, delivery, language, ...(voiceId ? { voice_id: voiceId } : {}) }
    }
    setBusy(true)
    try {
      onCreated(await api.create(body))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.kind} type="button" role="tab" aria-selected={kind === t.kind}
            onClick={() => { setKind(t.kind); setError(null) }}>
            {t.label}
          </button>
        ))}
      </div>
      <Hint>{tab.hint}</Hint>

      {kind === 'sfx' && (
        <>
          <div className="control">
            <span className="meta-label">What kind?</span>
            <Chips label="Kind of sound" value={category} onChange={(c) => { setCategory(c); setSfxSeconds('') }}
              options={SFX_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))} />
          </div>
          <label className="control">
            <span className="meta-label">Describe it</span>
            <textarea className="textarea" value={sfxPrompt} onChange={(e) => setSfxPrompt(e.target.value)}
              placeholder={cat.example} maxLength={LIMITS.prompt} />
            <Hint>Tip: {cat.tip} Leave it empty to try the example.</Hint>
          </label>
          {cat.loop ? (
            <Hint>Ambience loops forever without a gap, so it can play under a whole level.</Hint>
          ) : (
            <div className="control">
              <span className="meta-label">Versions</span>
              <Chips label="Versions" value={versions} onChange={setVersions}
                options={[{ value: 1, label: '1' }, { value: 4, label: '4' }]} />
              <Hint>4 gives slightly different takes, so a sound that repeats (like steps) never sounds robotic.</Hint>
            </div>
          )}
        </>
      )}

      {kind === 'music' && (
        <>
          <label className="control">
            <span className="meta-label">Describe it</span>
            <textarea className="textarea" value={musicPrompt} onChange={(e) => setMusicPrompt(e.target.value)}
              placeholder={MUSIC_EXAMPLE} maxLength={LIMITS.prompt} />
            <Hint>Tip: say the mood, the instruments and the speed (for example 90 BPM).</Hint>
          </label>
          <div className="control">
            <span className="meta-label">Length</span>
            <Chips label="Length" value={length} onChange={setLength}
              options={MUSIC_LENGTHS.map((s) => ({ value: s, label: s < 60 ? `${s} s` : `${s / 60} min` }))} />
          </div>
          <label className="switch">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            <span className="meta-label">Loop</span>
            <span className="hint">{loop ? 'Repeats forever without a gap, for levels and menus.' : 'Plays once, with a natural ending.'}</span>
          </label>
        </>
      )}

      {kind === 'voice' && (
        <>
          <label className="control">
            <span className="meta-label">Line</span>
            <textarea className="textarea" value={line} onChange={(e) => setLine(e.target.value)}
              placeholder={VOICE_EXAMPLE} maxLength={LIMITS.line} />
            <Hint>Write it exactly as it should be said. Punctuation changes the rhythm.</Hint>
          </label>
          <div className="control">
            <span className="meta-label">Voice</span>
            <div className="voice-pick">
              <select className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                <option value="">{DEFAULT_VOICE_LABEL}</option>
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <button type="button" className="button button--small button--outline" onClick={onRecordVoice}>+ Record a voice</button>
            </div>
          </div>
          <label className="control">
            <span className="meta-label">Delivery</span>
            <div className="delivery">
              <span className="meta-label">Calm</span>
              <input className="range" type="range" min={LIMITS.delivery[0]} max={1.25} step={0.05} value={delivery}
                onChange={(e) => setDelivery(Number(e.target.value))} aria-label="Delivery" />
              <span className="meta-label">Dramatic</span>
            </div>
          </label>
        </>
      )}

      <button type="submit" className="button button--wide" disabled={busy}>{busy ? 'Sending…' : 'Generate'}</button>
      {error && <p className="error">{error}</p>}

      <details className="more-options" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
        <summary className="meta-label">More options</summary>
        {kind === 'voice' ? (
          <label className="control">
            <span className="meta-label">Language</span>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
        ) : (
          <>
            {kind === 'sfx' && (
              <label className="control">
                <span className="meta-label">Exact length (seconds)</span>
                <input className="input" type="number" step={0.5}
                  min={(cat.loop ? LIMITS.ambienceSeconds : LIMITS.sfxSeconds)[0]}
                  max={(cat.loop ? LIMITS.ambienceSeconds : LIMITS.sfxSeconds)[1]}
                  value={sfxSeconds} placeholder={String(cat.seconds)}
                  onChange={(e) => setSfxSeconds(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
            )}
            <label className="switch">
              <input type="checkbox" checked={exactWords} onChange={(e) => setExactWords(e.target.checked)} />
              <span className="meta-label">Use my exact words</span>
              <span className="hint">Off: a helper rewrites your idea into a detailed description first (usually better).</span>
            </label>
            <label className="control">
              <span className="meta-label">Seed</span>
              <input className="input" inputMode="numeric" pattern="[0-9]*" value={seed} onChange={(e) => setSeed(e.target.value)}
                placeholder="Random" />
              <Hint>The same words and seed give the same sound again.</Hint>
            </label>
          </>
        )}
      </details>
    </form>
  )
}
