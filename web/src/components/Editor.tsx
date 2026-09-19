import { useEffect, useRef, useState } from 'react'

import { api, previewUrl, type Take } from '../api'
import { load } from '../audio'

const FADES = [
  { label: 'Off', value: 0 },
  { label: 'Short', value: 0.05 },
  { label: 'Long', value: 0.5 },
]

const fmt = (s: number) => `${s.toFixed(2)} s`

/** Drag the two handles to keep a part of the sound; fades smooth the edges. Saves a new take. */
export function Editor({ take, onCreated, onClose }: { take: Take; onCreated: (ts: Take[]) => void; onClose: () => void }) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [range, setRange] = useState<[number, number]>([0, 1])
  const [fadeIn, setFadeIn] = useState(0)
  const [fadeOut, setFadeOut] = useState(0.05)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<0 | 1 | null>(null)
  const playing = useRef<AudioBufferSourceNode | null>(null)

  useEffect(() => {
    load(previewUrl(take)).then(setBuffer).catch(() => setError('Could not load the sound.'))
    return () => playing.current?.stop()
  }, [take])

  useEffect(() => {
    const c = canvas.current
    if (!c || !buffer) return
    const ratio = window.devicePixelRatio || 1
    c.width = c.clientWidth * ratio
    c.height = c.clientHeight * ratio
    const g = c.getContext('2d')!
    const ink = getComputedStyle(c).color
    const data = buffer.getChannelData(0)
    const bars = 160
    const step = Math.floor(data.length / bars)
    g.clearRect(0, 0, c.width, c.height)
    for (let i = 0; i < bars; i++) {
      let peak = 0
      for (let j = i * step; j < (i + 1) * step; j += 32) peak = Math.max(peak, Math.abs(data[j]))
      const inside = i / bars >= range[0] && i / bars <= range[1]
      g.globalAlpha = inside ? 1 : 0.2
      g.fillStyle = ink
      const h = Math.max(ratio, peak * c.height)
      g.fillRect((i * c.width) / bars, (c.height - h) / 2, Math.max(1, c.width / bars - ratio), h)
    }
  }, [buffer, range])

  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  }
  const onDown = (e: React.PointerEvent) => {
    const x = at(e)
    drag.current = Math.abs(x - range[0]) < Math.abs(x - range[1]) ? 0 : 1
    e.currentTarget.setPointerCapture(e.pointerId)
    onMove(e)
  }
  const onMove = (e: React.PointerEvent) => {
    if (drag.current === null) return
    const x = at(e)
    setRange(([a, b]) => (drag.current === 0 ? [Math.min(x, b - 0.01), b] : [a, Math.max(x, a + 0.01)]))
  }

  function play() {
    if (!buffer) return
    playing.current?.stop()
    const ctx = new AudioContext()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.start(0, range[0] * buffer.duration, (range[1] - range[0]) * buffer.duration)
    playing.current = src
  }

  async function save() {
    if (!buffer) return
    setSaving(true)
    setError(null)
    try {
      const d = buffer.duration
      onCreated(await api.create({ parent_id: take.id, edit: { start: range[0] * d, end: range[1] * d, fade_in: fadeIn, fade_out: fadeOut } }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const d = buffer?.duration ?? 0
  return (
    <div className="editor">
      <p className="hint">Drag the two edges to keep only the part you want. The original stays as it is.</p>
      <div className="editor__wave">
        <canvas ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}
          aria-label="Waveform: drag the edges to trim" />
        <span className="editor__handle" style={{ left: `${range[0] * 100}%` }} />
        <span className="editor__handle" style={{ left: `${range[1] * 100}%` }} />
      </div>
      <p className="meta-label">{fmt(range[0] * d)} → {fmt(range[1] * d)} · keeps {fmt((range[1] - range[0]) * d)}</p>
      <div className="editor__fades">
        {([['Fade in', fadeIn, setFadeIn], ['Fade out', fadeOut, setFadeOut]] as const).map(([label, value, set]) => (
          <div key={label} className="editor__fade">
            <span className="meta-label">{label}</span>
            <div className="chips chips--small" role="radiogroup" aria-label={label}>
              {FADES.map((f) => (
                <button key={f.label} type="button" role="radio" aria-checked={value === f.value} onClick={() => set(f.value)}>{f.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card__actions">
        <button type="button" className="button button--small button--outline" onClick={play} disabled={!buffer}>▶ Play selection</button>
        <button type="button" className="button button--small" onClick={save} disabled={!buffer || saving}>{saving ? 'Saving…' : 'Save trimmed copy'}</button>
        <button type="button" className="button button--small button--outline" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
