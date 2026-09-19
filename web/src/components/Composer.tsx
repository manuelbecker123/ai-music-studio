import { useState } from 'react'

import { api, type NewTake, type Take, type Voice } from '../api'
import { VoiceRecorder } from './VoiceRecorder'
import {
  DEFAULT_VOICE_LABEL, DELIVERY, LANGUAGES, accentLabel, LIMITS, LYRICS_EXAMPLE, MUSIC_EXAMPLE, MUSIC_LENGTHS, PRESET_VOICES,
  SFX_CATEGORIES, VOICE_EXAMPLE, sfxCategory, type Kind,
} from '../catalog'

const SONG_LENGTHS = [60, 120, 180]
const SONG_EXAMPLE = 'Cheerful folk song with acoustic guitar, fiddle and a warm female voice'

const TABS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'sfx', label: 'Sound effects', hint: 'Short sounds: steps, hits, spells, clicks, creatures, backgrounds.' },
  { kind: 'music', label: 'Music', hint: 'Background music for a level or a menu.' },
  { kind: 'voice', label: 'Voice', hint: 'Spoken lines for characters.' },
]

type Props = {
  voices: Voice[]
  onCreated: (ts: Take[]) => void
  onVoiceAdded: (v: Voice) => void
  onVoiceDeleted: (id: string) => void
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

export function Composer({ voices, onCreated, onVoiceAdded, onVoiceDeleted }: Props) {
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
  const [vocals, setVocals] = useState(false)
  const [lyrics, setLyrics] = useState('')
  const [songLength, setSongLength] = useState(120)
  // voice
  const [line, setLine] = useState('')
  // null = the default: a recorded voice named "Narrator" if there is one, else the Warm narrator
  // preset (clearer than Chatterbox's built-in voice, which can swallow a line's first word)
  const [voiceChoice, setVoiceChoice] = useState<string | null>(null)
  const narrator = voices.find((v) => v.name.trim().toLowerCase() === DEFAULT_VOICE_LABEL.toLowerCase())
  const voiceId = voiceChoice ?? narrator?.id ?? PRESET_VOICES[0].id
  const [recording, setRecording] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const recorded = voices.find((v) => v.id === voiceId)

  async function deleteVoice() {
    if (!recorded) return
    try {
      await api.deleteVoice(recorded.id)
      onVoiceDeleted(recorded.id)
      setVoiceChoice(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setConfirmDelete(false)
    }
  }
  const [delivery, setDelivery] = useState(0.5)
  const [language, setLanguage] = useState('en') // voice: the accent; songs: the lyrics' language
  const [translateTo, setTranslateTo] = useState('')
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
    } else if (kind === 'music' && vocals) {
      body = { kind, vocals: true, prompt: musicPrompt || SONG_EXAMPLE, lyrics: lyrics || LYRICS_EXAMPLE, seconds: songLength, language }
    } else if (kind === 'music') {
      body = { kind, prompt: musicPrompt || MUSIC_EXAMPLE, seconds: length, loop, ...shared }
    } else {
      body = { kind, prompt: line || VOICE_EXAMPLE, delivery, language, ...(voiceId ? { voice_id: voiceId } : {}),
               ...(translateTo ? { translate_to: translateTo } : {}) }
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
              placeholder={vocals ? SONG_EXAMPLE : MUSIC_EXAMPLE} maxLength={LIMITS.prompt} />
            <Hint>{vocals ? 'Tip: say the style, the instruments and the singer (female, male, choir…).'
                          : 'Tip: say the mood, the instruments and the speed (for example 90 BPM).'}</Hint>
          </label>
          <label className="switch">
            <input type="checkbox" checked={vocals} onChange={(e) => setVocals(e.target.checked)} />
            <span className="meta-label">Vocals</span>
            <span className="hint">{vocals ? 'A song with your lyrics sung (plays once).' : 'Instrumental, no singing.'}</span>
          </label>
          {vocals ? (
            <>
              <label className="control">
                <span className="meta-label">Lyrics</span>
                <textarea className="textarea textarea--tall" value={lyrics} onChange={(e) => setLyrics(e.target.value)}
                  placeholder={LYRICS_EXAMPLE} maxLength={LIMITS.lyrics} />
                <Hint>Mark parts with [verse] and [chorus] on their own line. Leave it empty to try the example.</Hint>
              </label>
              <div className="control">
                <span className="meta-label">Length</span>
                <Chips label="Length" value={songLength} onChange={setSongLength}
                  options={SONG_LENGTHS.map((s) => ({ value: s, label: `${s / 60} min` }))} />
              </div>
            </>
          ) : (
            <>
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
              <select className="input" value={voiceId} onChange={(e) => { setVoiceChoice(e.target.value); setConfirmDelete(false) }}>
                {narrator && <option value={narrator.id}>{narrator.name}</option>}
                <optgroup label="Presets">
                  {PRESET_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </optgroup>
                {voices.some((v) => v !== narrator) && (
                  <optgroup label="Your voices">
                    {voices.filter((v) => v !== narrator).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </optgroup>
                )}
                <option value="">Built-in voice</option>
              </select>
              <button type="button" className="button button--small button--outline" onClick={() => setRecording(true)}>Record a voice</button>
            </div>
            {recorded && !confirmDelete && (
              <button type="button" className="link-button meta-label delete-link" onClick={() => setConfirmDelete(true)}>
                Delete the “{recorded.name}” recording
              </button>
            )}
            {recorded && confirmDelete && (
              <div className="confirm" role="alertdialog" aria-label="Delete voice">
                <p className="hint">
                  Delete “{recorded.name}” for good? The recording and local model copy are erased. Sounds
                  already made with it are kept.
                </p>
                <div className="card__actions">
                  <button type="button" className="button button--small" onClick={deleteVoice}>Delete permanently</button>
                  <button type="button" className="button button--small button--outline" onClick={() => setConfirmDelete(false)}>Keep it</button>
                </div>
              </div>
            )}
          </div>
          <div className="control">
            <span className="meta-label">Delivery</span>
            <Chips label="Delivery" value={delivery} onChange={setDelivery}
              options={DELIVERY.map((d) => ({ value: d.value, label: d.label }))} />
            <Hint>How much feeling goes into it. Dramatic works best for short, emotional lines.</Hint>
          </div>
        </>
      )}

      <button type="submit" className="button button--wide" disabled={busy}>{busy ? 'Sending…' : 'Generate'}</button>
      {error && <p className="error">{error}</p>}

      <details className="more-options" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
        <summary className="meta-label">More options</summary>
        {kind === 'voice' ? (
          <>
            <label className="control">
              <span className="meta-label">Translate to</span>
              <select className="input" value={translateTo} onChange={(e) => setTranslateTo(e.target.value)}>
                <option value="">Don't translate</option>
                {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
              <Hint>Write the line in any language; it is translated and spoken natively. The card shows what was said.</Hint>
            </label>
            <label className="control">
              <span className="meta-label">Accent</span>
              <select className="input" value={translateTo ? translateTo : language} disabled={!!translateTo}
                onChange={(e) => setLanguage(e.target.value)}>
                {Object.keys(LANGUAGES).map((code) => <option key={code} value={code}>{accentLabel(code)}</option>)}
              </select>
              <Hint>{translateTo ? 'Translated lines are spoken with a native accent.' : 'Speaks the line as written, with this accent.'}</Hint>
            </label>
          </>
        ) : kind === 'music' && vocals ? (
          <label className="control">
            <span className="meta-label">Lyrics language</span>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <Hint>The language the lyrics are written in, so they are sung with the right pronunciation.</Hint>
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
      {recording && (
        <VoiceRecorder
          onClose={() => setRecording(false)}
          onSaved={(v) => {
            onVoiceAdded(v)
            setVoiceChoice(v.id) // use the new voice right away
            setRecording(false)
          }}
        />
      )}
    </form>
  )
}
