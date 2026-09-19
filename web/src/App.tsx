import { useEffect, useRef, useState } from 'react'

import { MODES, createJob, getAudio, getJob, health, type GenerationRequest, type Health, type Mode } from './api'
import { Take, type Track } from './components/Take'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<Mode>('Music')
  const [seconds, setSeconds] = useState(30)
  const [enhance, setEnhance] = useState(true)
  const [seed, setSeed] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [status, setStatus] = useState<Health | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const urls = useRef<string[]>([])

  const busy = tracks.some((t) => t.status === 'queued' || t.status === 'in_progress')

  useEffect(() => {
    const check = () => health().then(setStatus).catch(() => setStatus({ comfyui: false, missing_models: [] }))
    check()
    const t = setInterval(check, 15_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [busy])

  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), [])

  const update = (id: string, patch: Partial<Track>) =>
    setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  async function generate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const body: GenerationRequest = { prompt, seconds, mode, enhance }
    if (seed.trim()) body.seed = Number(seed)
    let job
    try {
      job = await createJob(body)
    } catch (err) {
      setError((err as Error).message)
      return
    }
    const startedAt = Date.now()
    setTracks((ts) => [{ ...job, prompt, startedAt }, ...ts])
    try {
      for (;;) {
        await sleep(1000)
        const s = await getJob(job.id)
        update(job.id, s)
        if (s.status === 'failed') return
        if (s.status === 'completed') break
      }
      const url = URL.createObjectURL(await getAudio(job.id))
      urls.current.push(url)
      update(job.id, { url, tookMs: Date.now() - startedAt })
    } catch (err) {
      update(job.id, { status: 'failed', error: { message: (err as Error).message } })
    }
  }

  const headerStatus = !status
    ? '…'
    : !status.comfyui
      ? 'ComfyUI offline'
      : status.missing_models.length
        ? 'Models missing'
        : busy
          ? 'Working'
          : 'Ready'

  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <span className="meta-label">Stable Audio 3 · ComfyUI</span>
          <span className="brand-mark">
            Music Studio
            <span className="brand-mark__dot" />
          </span>
          <span className="meta-label">{headerStatus}</span>
        </div>
      </header>

      <main className="container">
        <section className="intro">
          <h1 className="page-title">Music Studio</h1>
          <p className="lede">Describe a track, an instrument or a sound effect.</p>
          {status?.missing_models.length ? (
            <p className="error">ComfyUI is missing: {status.missing_models.join(', ')}. See the README.</p>
          ) : null}
        </section>

        <section className="studio">
          <form onSubmit={generate} className="composer">
            <label className="control">
              <span className="meta-label">Prompt</span>
              <textarea
                className="textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Upbeat funk groove with slap bass, clean guitar and brass stabs, 105 BPM"
                maxLength={2000}
                required
              />
            </label>

            <fieldset className="control">
              <legend className="meta-label">Mode</legend>
              <div className="segments" role="radiogroup" aria-label="Mode">
                {MODES.map((m) => (
                  <button type="button" key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                    {m}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="control">
              <span className="meta-label">Length · seconds</span>
              <div className="length">
                <input
                  className="range"
                  type="range"
                  min={1}
                  max={180}
                  value={seconds}
                  aria-label="Length in seconds"
                  onChange={(e) => setSeconds(Number(e.target.value))}
                />
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  max={180}
                  step={0.5}
                  value={seconds}
                  aria-label="Length in seconds"
                  onChange={(e) => setSeconds(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="options">
              <label className="check">
                <input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} />
                <span className="meta-label">Enhance prompt</span>
              </label>
              <label className="seed">
                <span className="meta-label">Seed</span>
                <input
                  className="input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder="Random"
                />
              </label>
            </div>

            <button type="submit" className="button button--wide" disabled={!prompt.trim()}>
              Generate
            </button>
            {error && <p className="error">{error}</p>}
          </form>

          <section className="takes" aria-label="Results">
            <div className="takes__head">
              <span className="meta-label">Takes</span>
              <span className="meta-label">{tracks.length}</span>
            </div>
            {tracks.length === 0 && <p className="takes__empty">Nothing generated yet.</p>}
            <ul className="takes__list">
              {tracks.map((t) => (
                <Take key={t.id} track={t} now={now} onReuseSeed={(s) => setSeed(String(s))} />
              ))}
            </ul>
          </section>
        </section>
      </main>
    </>
  )
}
