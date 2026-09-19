import { useEffect, useRef, useState } from 'react'

import { api, type Voice } from '../api'
import { DEFAULT_VOICE_LABEL } from '../catalog'

const MAX_SECONDS = 20

// Records through Web Audio and writes a WAV in the page. MediaRecorder is not available in every
// browser, and where it is the formats differ; plain PCM works everywhere, Safari included.

function wav(chunks: Float32Array[], rate: number): Blob {
  const samples = chunks.reduce((n, c) => n + c.length, 0)
  const view = new DataView(new ArrayBuffer(44 + samples * 2))
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples * 2, true)
  let at = 44
  for (const c of chunks) for (const v of c) {
    view.setInt16(at, Math.max(-1, Math.min(1, v)) * 0x7fff, true)
    at += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}

type Session = { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[]; began: number }

/** Records about 10 seconds of someone speaking; the voice model copies how it sounds. */
export function VoiceRecorder({ onSaved, onClose }: { onSaved: (v: Voice) => void; onClose: () => void }) {
  const [name, setName] = useState(DEFAULT_VOICE_LABEL)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [clip, setClip] = useState<Blob | null>(null)
  const [clipUrl, setClipUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<Session | null>(null)

  useEffect(() => () => finish(false), []) // release the microphone if the dialog closes mid-recording
  useEffect(() => () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }, [clipUrl])

  function keepClip(blob: Blob, length: number) {
    setClip(blob)
    setClipUrl(URL.createObjectURL(blob))
    setSeconds(length)
  }

  async function start() {
    setError(null)
    setClip(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record here. Choose a recording file instead.')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      const denied = (e as DOMException).name === 'NotAllowedError'
      setError(denied ? 'Microphone access was blocked. Allow it for this site in the browser settings, then try again.'
                      : 'No microphone was found.')
      return
    }
    const ctx = new AudioContext()
    await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    const began = performance.now()
    node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      chunks.push(data)
      let sum = 0
      for (const v of data) sum += v * v
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 6))
      const s = (performance.now() - began) / 1000
      setSeconds(s)
      if (s >= MAX_SECONDS) finish(true)
    }
    source.connect(node)
    node.connect(ctx.destination) // Safari only runs the processor when it is connected; it outputs silence
    session.current = { stream, ctx, node, chunks, began }
    setRecording(true)
  }

  function finish(keep: boolean) {
    const s = session.current
    if (!s) return
    session.current = null
    s.node.onaudioprocess = null
    s.node.disconnect()
    s.stream.getTracks().forEach((t) => t.stop())
    void s.ctx.close()
    setRecording(false)
    setLevel(0)
    if (keep && s.chunks.length) keepClip(wav(s.chunks, s.ctx.sampleRate), (performance.now() - s.began) / 1000)
  }

  function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(file.size > 5 * 1024 * 1024 ? 'That file is too big. Use a clip of about 10 seconds.' : null)
    if (file.size <= 5 * 1024 * 1024) keepClip(file, 10)
  }

  async function save() {
    if (!clip) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await api.addVoice(name.trim(), clip))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Record a voice">
      <div className="modal__box">
        <h2 className="modal__title">New voice</h2>
        <p className="hint">
          Read anything out loud for about 10 seconds. Every line spoken with this voice will sound like
          your recording. Keep the name “{DEFAULT_VOICE_LABEL}” to make it the default voice. Only record yourself,
          or someone who said yes.
        </p>
        <label className="control">
          <span className="meta-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <div className="recorder">
          {recording ? (
            <button type="button" className="button" onClick={() => finish(true)}>Stop · {Math.floor(seconds)} s</button>
          ) : (
            <button type="button" className="button button--outline" onClick={start}>{clip ? 'Record again' : 'Record'}</button>
          )}
          {recording && <span className="level" aria-hidden><span style={{ width: `${level * 100}%` }} /></span>}
          {clipUrl && !recording && <audio controls src={clipUrl} />}
        </div>
        {!recording && (
          <label className="hint file-pick">
            Or choose a recording: <input type="file" accept="audio/*" onChange={choose} />
          </label>
        )}
        {clip && !recording && seconds < 5 && <p className="hint">That was short. 8 to 15 seconds works best.</p>}
        {error && <p className="error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="button" disabled={!clip || recording || saving || !name.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Save voice'}
          </button>
          <button type="button" className="button button--outline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
