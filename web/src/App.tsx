import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, type Take, type Voice } from './api'
import { Composer } from './components/Composer'
import { Library } from './components/Library'
import { TakeCard } from './components/TakeCard'
import { VoiceRecorder } from './components/VoiceRecorder'

const pending = (t: Take) => t.status === 'queued' || t.status === 'in_progress'

export default function App() {
  const [takes, setTakes] = useState<Take[]>([])
  const [voices, setVoices] = useState<Voice[]>([])
  const [online, setOnline] = useState<boolean | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const merge = useCallback((incoming: Take[]) => {
    setTakes((ts) => {
      const byId = new Map(ts.map((t) => [t.id, t]))
      incoming.forEach((t) => byId.set(t.id, t))
      return [...byId.values()].sort((a, b) => b.created_at - a.created_at || a.name.localeCompare(b.name))
    })
  }, [])

  useEffect(() => {
    api.recent().then(merge).catch(() => {})
    api.voices().then(setVoices).catch(() => {})
    const check = () => api.status().then((s) => setOnline(s.agent_online)).catch(() => setOnline(null))
    check()
    const t = setInterval(check, 30_000)
    return () => clearInterval(t)
  }, [merge])

  const waitingIds = takes.filter(pending).map((t) => t.id).join()
  useEffect(() => {
    if (!waitingIds) return
    const ids = waitingIds.split(',')
    const t = setInterval(async () => {
      setNow(Date.now())
      const fresh = await Promise.all(ids.map((id) => api.take(id).catch(() => null)))
      merge(fresh.filter((x): x is Take => x !== null))
    }, 1500)
    return () => clearInterval(t)
  }, [waitingIds, merge])

  // Versions of one sound effect share a group and show as one card.
  const groups = useMemo(() => {
    const out = new Map<string, Take[]>()
    takes.forEach((t) => out.set(t.group_id, [...(out.get(t.group_id) ?? []), t]))
    return [...out.values()].map((g) => g.sort((a, b) => a.seed - b.seed)) // stable when a version is renamed
  }, [takes])

  const saved = takes.filter((t) => t.saved).length
  const retryVoice = async (t: Take) =>
    merge(await api.create({ kind: 'voice', prompt: t.prompt, delivery: t.delivery ?? 0.5, language: t.language ?? 'en',
                             ...(t.voice_id ? { voice_id: t.voice_id } : {}) }))

  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <span className="meta-label" title={online === false ? 'Start the local models to make new sounds' : undefined}>
            {online === null ? '…' : online ? 'Models ready' : 'Models offline'}
          </span>
          <span className="brand-mark">
            Music Studio
            <span className="brand-mark__pulse" />
          </span>
          <button type="button" className="meta-label link-button" onClick={() => setLibraryOpen(true)}>
            Library{saved ? ` · ${saved} saved here` : ''}
          </button>
        </div>
      </header>

      <main className="container studio">
        <Composer voices={voices} onCreated={merge} onRecordVoice={() => setRecording(true)} />

        <section className="takes" aria-label="Results">
          <div className="takes__head">
            <span className="meta-label">Your sounds</span>
            <span className="meta-label">last 24 hours</span>
          </div>
          {!groups.length && (
            <p className="takes__empty">
              Nothing yet. Pick what you are making on the left and press Generate; sounds appear here in a few seconds.
            </p>
          )}
          <ul className="takes__list">
            {groups.map((g) => (
              <TakeCard key={g[0].group_id} takes={g} now={now} onChange={(t) => merge([t])} onCreated={merge} onRetryVoice={retryVoice} />
            ))}
          </ul>
        </section>
      </main>

      {libraryOpen && <Library onClose={() => setLibraryOpen(false)} onChange={(t) => merge([t])} />}
      {recording && (
        <VoiceRecorder
          onClose={() => setRecording(false)}
          onSaved={(v) => {
            setVoices((vs) => [...vs, v].sort((a, b) => a.name.localeCompare(b.name)))
            setRecording(false)
          }}
        />
      )}
    </>
  )
}
