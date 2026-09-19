import { useEffect, useRef, useState } from 'react'

// Plays through Web Audio rather than <audio>: a decoded buffer loops with no gap at all,
// which is the only honest way to preview a seamless loop. One sound plays at a time.

let context: AudioContext | null = null
const buffers = new Map<string, Promise<AudioBuffer>>()
let stopCurrent: (() => void) | null = null

function audioContext() {
  context ??= new AudioContext()
  return context
}

function load(url: string): Promise<AudioBuffer> {
  if (!buffers.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`could not load audio (${r.status})`)
        return r.arrayBuffer()
      })
      .then((data) => audioContext().decodeAudioData(data))
    p.catch(() => buffers.delete(url))
    buffers.set(url, p)
  }
  return buffers.get(url)!
}

function peaks(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(data.length / bars))
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    let max = 0
    for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) max = Math.max(max, Math.abs(data[j]))
    out.push(max)
  }
  const top = Math.max(...out, 1e-6)
  return out.map((v) => v / top)
}

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Player({ url, loop, compact = false }: { url: string; loop: boolean; compact?: boolean }) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [error, setError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const playback = useRef<{ source: AudioBufferSourceNode; startedAt: number; offset: number } | null>(null)
  const frame = useRef(0)

  useEffect(() => {
    let alive = true
    load(url).then((b) => alive && setBuffer(b)).catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [url])

  useEffect(() => {
    const c = canvas.current
    if (!c || !buffer) return
    const bars = compact ? 60 : 120
    const values = peaks(buffer, bars)
    const ratio = window.devicePixelRatio || 1
    c.width = c.clientWidth * ratio
    c.height = c.clientHeight * ratio
    const g = c.getContext('2d')!
    const ink = getComputedStyle(c).color
    g.clearRect(0, 0, c.width, c.height)
    const w = c.width / bars
    values.forEach((v, i) => {
      const h = Math.max(1 * ratio, v * c.height)
      g.globalAlpha = i / bars <= position ? 1 : 0.35
      g.fillStyle = ink
      g.fillRect(i * w, (c.height - h) / 2, Math.max(1, w - ratio), h)
    })
  }, [buffer, position, compact])

  useEffect(() => () => stop(), []) // stop() only touches refs and setters

  function stop() {
    cancelAnimationFrame(frame.current)
    const p = playback.current
    if (p) {
      p.source.onended = null
      try {
        p.source.stop()
      } catch {
        /* already stopped */
      }
    }
    playback.current = null
    setPlaying(false)
  }

  function play(from: number) {
    if (!buffer) return
    stopCurrent?.()
    const ctx = audioContext()
    void ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = loop
    source.connect(ctx.destination)
    const offset = from * buffer.duration
    source.start(0, offset)
    playback.current = { source, startedAt: ctx.currentTime, offset }
    source.onended = () => {
      stop()
      setPosition(0)
    }
    stopCurrent = stop
    setPlaying(true)
    const tick = () => {
      const p = playback.current
      if (!p) return
      const t = (p.offset + ctx.currentTime - p.startedAt) % buffer.duration
      setPosition(t / buffer.duration)
      frame.current = requestAnimationFrame(tick)
    }
    tick()
  }

  function seek(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const at = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    setPosition(at)
    if (playing) play(at)
  }

  return (
    <div className={`player${compact ? ' player--compact' : ''}`}>
      <button
        type="button"
        className="player__toggle"
        aria-label={playing ? 'Stop' : 'Play'}
        aria-pressed={playing}
        disabled={!buffer}
        onClick={() => (playing ? stop() : play(position >= 0.999 ? 0 : position))}
      >
        {playing ? '■' : '▶'}
      </button>
      {error ? (
        <span className="meta-label">Audio unavailable</span>
      ) : (
        <canvas ref={canvas} className="player__wave" onClick={seek} aria-label="Waveform: click to jump" />
      )}
      {!compact && buffer && (
        <span className="meta-label player__time">
          {loop ? '∞ ' : ''}
          {time(buffer.duration)}
        </span>
      )}
    </div>
  )
}
