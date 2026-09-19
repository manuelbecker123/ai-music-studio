import type { Kind, Profile } from './catalog'

export type Take = {
  id: string
  group_id: string
  kind: Kind
  category: string | null
  profile: Profile
  prompt: string
  seconds: number
  seed: number
  parent_id: string | null
  voice_id: string | null
  delivery: number | null
  language: string | null
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  revised_prompt: string | null
  error: { message: string } | null
  name: string
  saved: boolean
  game_ext: 'wav' | 'ogg' | null
  duration: number | null
  created_at: number
  completed_at: number | null
  lyrics: string | null
  edited: boolean
  intensity: string | null
  song: boolean
}

export type Voice = { id: string; name: string }

export type NewTake =
  | { kind: 'sfx'; category: string; prompt: string; versions: 1 | 4; seconds?: number; enhance?: boolean; seed?: number }
  | { kind: 'music'; prompt: string; seconds: number; loop: boolean; enhance?: boolean; seed?: number }
  | { kind: 'music'; vocals: true; prompt: string; lyrics: string; seconds: number; language: string }
  | { kind: 'voice'; prompt: string; voice_id?: string; delivery: number; language: string }
  | { parent_id: string; difference: number }
  | { parent_id: string; edit: { start: number; end: number; fade_in: number; fade_out: number } }
  | { parent_id: string; intensity: true }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init)
  if (!r.ok) {
    const body = await r.json().catch(() => null)
    throw new Error(body?.detail ?? `Something went wrong (${r.status})`)
  }
  return r.json()
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  status: () => request<{ agent_online: boolean }>('/status'),
  recent: () => request<{ takes: Take[] }>('/takes').then((r) => r.takes),
  library: () => request<{ takes: Take[] }>('/library').then((r) => r.takes),
  take: (id: string) => request<Take>(`/takes/${id}`),
  create: (body: NewTake) => request<{ takes: Take[] }>('/takes', jsonBody('POST', body)).then((r) => r.takes),
  update: (id: string, body: { name?: string; saved?: boolean }) => request<Take>(`/takes/${id}`, jsonBody('PATCH', body)),
  voices: () => request<{ voices: Voice[] }>('/voices').then((r) => r.voices),
  addVoice: (name: string, audio: Blob) => {
    const form = new FormData()
    form.append('name', name)
    form.append('audio', audio, `recording.${audio.type.includes('mp4') ? 'mp4' : 'webm'}`)
    return request<Voice>('/voices', { method: 'POST', body: form })
  },
  deleteVoice: (id: string) => request<{ ok: true }>(`/voices/${id}`, { method: 'DELETE' }),
}

export const previewUrl = (t: Take) => `/api/takes/${t.id}/preview`
export const fileUrl = (t: Take) => `/api/takes/${t.id}/file`
export const fileName = (t: Take) => `${t.name}.${t.game_ext}`
export const isLoop = (t: Take) => t.profile === 'music' || t.profile === 'ambience'
