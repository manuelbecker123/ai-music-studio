import { useEffect, useRef, useState } from 'react'

import { api, type Voice } from '../api'

const MAX_SECONDS = 20

function mimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']) if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

/** Records about 10 seconds of someone speaking; the voice model copies how it sounds. */
export function VoiceRecorder({ onSaved, onClose }: { onSaved: (v: Voice) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef(0)

  useEffect(() => () => {
    clearInterval(timer.current)
    recorder.current?.stream.getTracks().forEach((t) => t.stop())
  }, [])

  async function start() {
    setError(null)
    setClip(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = mimeType()
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const chunks: Blob[] = []
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        setClip(new Blob(chunks, { type: r.mimeType }))
      }
      recorder.current = r
      r.start()
      setRecording(true)
      setSeconds(0)
      const began = Date.now()
      timer.current = window.setInterval(() => {
        const s = (Date.now() - began) / 1000
        setSeconds(s)
        if (s >= MAX_SECONDS) stop()
      }, 200)
    } catch {
      setError('The browser did not allow the microphone.')
    }
  }

  function stop() {
    clearInterval(timer.current)
    if (recorder.current?.state === 'recording') recorder.current.stop()
    setRecording(false)
  }

  async function save() {
    if (!clip) return
    try {
      onSaved(await api.addVoice(name.trim(), clip))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Record a voice">
      <div className="modal__box">
        <h2 className="modal__title">New voice</h2>
        <p className="hint">
          Read anything out loud for about 10 seconds, in the character's voice. Every line spoken with
          this voice will sound like your recording. Only record yourself, or someone who said yes.
        </p>
        <label className="control">
          <span className="meta-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Old wizard" maxLength={40} />
        </label>
        <div className="recorder">
          {recording ? (
            <button type="button" className="button" onClick={stop}>■ Stop · {Math.floor(seconds)} s</button>
          ) : (
            <button type="button" className="button button--outline" onClick={start}>● {clip ? 'Record again' : 'Record'}</button>
          )}
          {clip && !recording && <audio controls src={URL.createObjectURL(clip)} />}
        </div>
        {clip && !recording && seconds < 5 && <p className="hint">That was short. 8 to 15 seconds works best.</p>}
        {error && <p className="error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="button" disabled={!clip || recording || !name.trim()} onClick={save}>Save voice</button>
          <button type="button" className="button button--outline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
