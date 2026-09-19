import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, type Take, type Voice } from './api'
import { useBasket } from './basket'
import { Basket } from './components/Basket'
import { Composer } from './components/Composer'
import { Library } from './components/Library'
import { TakeCard } from './components/TakeCard'

const pending = (t: Take) => t.status === 'queued' || t.status === 'in_progress'

export default function App() {
  const [takes, setTakes] = useState<Take[]>([])
  const [voices, setVoices] = useState<Voice[]>([])
  const [online, setOnline] = useState<boolean | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [basketOpen, setBasketOpen] = useState(false)
  const basket = useBasket()
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
  const removeTakes = (ids: string[]) => setTakes((ts) => ts.filter((t) => !ids.includes(t.id)))
  // "Another take" for voice lines and songs: the same request again (both models sample).
  const retryVoice = async (t: Take) =>
    merge(await api.create(t.song
      ? { kind: 'music', vocals: true, prompt: t.prompt, lyrics: t.lyrics ?? '', seconds: t.seconds, language: t.language ?? 'en' }
      : { kind: 'voice', prompt: t.prompt, delivery: t.delivery ?? 0.5, language: t.language ?? 'en',
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
          <span className="header-links">
            <button type="button" className="meta-label link-button" onClick={() => setLibraryOpen(true)}>
              Library{saved ? ` · ${saved}` : ''}
            </button>
            <button type="button" className="meta-label link-button" onClick={() => setBasketOpen(true)}>
              Basket · {basket.ids.length}
            </button>
          </span>
        </div>
      </header>

      <main className="container studio">
        <Composer
          voices={voices}
          onCreated={merge}
          onVoiceAdded={(v) => {
            // a voice with the same name replaces the old one on the local server too
            const same = (a: Voice) => a.name.trim().toLowerCase() === v.name.trim().toLowerCase()
            setVoices((vs) => [...vs.filter((x) => !same(x)), v].sort((a, b) => a.name.localeCompare(b.name)))
          }}
          onVoiceDeleted={(id) => setVoices((vs) => vs.filter((v) => v.id !== id))}
        />

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
              <TakeCard key={g[0].group_id} takes={g} now={now} onChange={(t) => merge([t])} onCreated={merge}
                onRetryVoice={retryVoice} onDeleted={removeTakes} />
            ))}
          </ul>
        </section>
      </main>

      {libraryOpen && <Library onClose={() => setLibraryOpen(false)} onChange={(t) => merge([t])} onDeleted={removeTakes} />}
      {basketOpen && <Basket onClose={() => setBasketOpen(false)} />}
    </>
  )
}
