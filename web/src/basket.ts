import { useCallback, useEffect, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'

import { fileName, fileUrl, isLoop, type Take } from './api'
import { DELIVERY, LANGUAGES, PRESET_VOICES, SFX_CATEGORIES } from './catalog'

// The basket is a per-browser selection of takes to export, kept in localStorage. It is a
// convenience: if storage is unavailable it simply starts empty.

const KEY = 'music-studio.basket'
const listeners = new Set<(ids: string[]) => void>()

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* private mode or storage blocked: keep it in memory for this page */
  }
  listeners.forEach((l) => l(ids))
}

export function useBasket() {
  const [ids, setIds] = useState<string[]>(read)
  useEffect(() => {
    listeners.add(setIds)
    return () => {
      listeners.delete(setIds)
    }
  }, [])
  const has = useCallback((id: string) => ids.includes(id), [ids])
  const toggle = useCallback((id: string) => write(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]), [ids])
  const add = useCallback((more: string[]) => write([...new Set([...ids, ...more])]), [ids])
  const remove = useCallback((id: string) => write(ids.filter((x) => x !== id)), [ids])
  const clear = useCallback(() => write([]), [])
  return { ids, has, toggle, add, remove, clear }
}

const MODELS = {
  sfx: 'Stable Audio 3 Medium (Stability AI Community License)',
  music: 'Stable Audio 3 Medium (Stability AI Community License)',
  song: 'ACE-Step 1.5 XL turbo (Apache-2.0)',
  voice: 'Chatterbox Multilingual (MIT); preset voices rendered with Kokoro-82M (Apache-2.0)',
}

/** Everything a game project may want to know about a file, next to it as <name>.json. */
export function metadata(t: Take) {
  const loop = isLoop(t)
  const voice = t.voice_id ? PRESET_VOICES.find((v) => v.id === t.voice_id)?.label ?? 'recorded voice' : t.kind === 'voice' ? 'Built-in voice' : null
  return {
    name: t.name,
    file: fileName(t),
    kind: t.kind === 'music' && t.song ? 'song' : t.kind,
    category: SFX_CATEGORIES.find((c) => c.id === t.category)?.label ?? null,
    description: t.prompt,
    model_description: t.revised_prompt?.replace(/\s*Length:\s*[\d.]+\s*seconds?\.?/i, '').trim() ?? null,
    lyrics: t.lyrics,
    voice,
    delivery: t.delivery == null ? null : DELIVERY.reduce((a, b) => (Math.abs(b.value - t.delivery!) < Math.abs(a.value - t.delivery!) ? b : a)).label,
    // voice: the spoken language is only known when the line was translated
    language: t.translate_to ? LANGUAGES[t.translate_to] : t.kind === 'voice' ? null : t.language ? LANGUAGES[t.language] ?? t.language : null,
    accent: t.kind === 'voice' && !t.translate_to && t.language && t.language !== 'en' ? `${LANGUAGES[t.language]} accent` : null,
    spoken_text: t.kind === 'voice' ? (t.translate_to ? t.revised_prompt : t.prompt) : null,
    translated_from: t.translate_to ? t.prompt : null,
    intensity: t.intensity,
    trimmed: t.edited,
    duration_seconds: t.duration,
    loop,
    format: t.game_ext === 'ogg' ? 'OGG Vorbis' : 'WAV 16-bit PCM',
    sample_rate: 44100,
    channels: t.game_ext === 'ogg' ? 2 : 1,
    loudness: t.game_ext === 'ogg' ? (t.profile === 'ambience' ? '-20 LUFS' : '-16 LUFS') : t.kind === 'voice' ? '-18 LUFS' : 'peak -1 dBFS',
    seed: t.seed,
    model: MODELS[t.kind === 'music' && t.song ? 'song' : t.kind],
    created_at: new Date(t.created_at * 1000).toISOString(),
    godot: loop ? 'Select the file, open the Import tab, tick Loop, then Reimport.' : null,
  }
}

/** A zip with one folder per take: <kind>/<name>/<name>.<ext> and <name>.json. */
export async function exportZip(takes: Take[], onProgress?: (done: number) => void): Promise<Blob> {
  const files: Record<string, Uint8Array> = {}
  let done = 0
  for (const t of takes) {
    const folder = `${t.kind === 'music' && t.song ? 'songs' : t.kind}/${t.name}`
    files[`${folder}/${fileName(t)}`] = new Uint8Array(await (await fetch(fileUrl(t))).arrayBuffer())
    files[`${folder}/${t.name}.json`] = strToU8(JSON.stringify(metadata(t), null, 2) + '\n')
    onProgress?.(++done)
  }
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' })
}
