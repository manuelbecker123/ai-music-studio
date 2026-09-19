import type { Job } from '../api'

export type Track = Job & { prompt: string; url?: string; startedAt: number; tookMs?: number }

function statusLabel(t: Track, now: number) {
  if (t.status === 'completed') return `Done in ${((t.tookMs ?? 0) / 1000).toFixed(1)} s`
  if (t.status === 'failed') return 'Failed'
  const elapsed = Math.max(0, (now - t.startedAt) / 1000).toFixed(0)
  return `${t.status === 'queued' ? 'Queued' : 'Generating'} · ${elapsed} s`
}

export function Take({ track: t, now, onReuseSeed }: { track: Track; now: number; onReuseSeed: (seed: number) => void }) {
  return (
    <li className="take">
      <div className="take__meta meta-label">
        <span>{t.mode}</span>
        <span>{t.seconds} s</span>
        <span>Seed {t.seed}</span>
        <span>{statusLabel(t, now)}</span>
      </div>
      <p className="take__prompt">{t.prompt}</p>
      {t.revised_prompt && t.revised_prompt !== t.prompt && <p className="take__revised">{t.revised_prompt}</p>}
      {t.error && <p className="error">{t.error.message}</p>}
      {t.url && (
        <>
          <audio controls src={t.url} />
          <div className="take__actions">
            <a className="button button--small" href={t.url} download={`${t.mode.toLowerCase()}-${t.seed}.mp3`}>
              Download
            </a>
            <button type="button" className="button button--small button--outline" onClick={() => onReuseSeed(t.seed)}>
              Reuse seed
            </button>
          </div>
        </>
      )}
    </li>
  )
}
