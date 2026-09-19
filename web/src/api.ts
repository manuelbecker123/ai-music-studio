export const MODES = ['Music', 'Instrument', 'SFX', 'One-shot'] as const
export type Mode = (typeof MODES)[number]

export type Job = {
  id: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  seconds: number
  mode: Mode
  seed: number
  revised_prompt: string | null
  error: { message: string } | null
}

export type Health = { comfyui: boolean; missing_models: string[] }

export type GenerationRequest = {
  prompt: string
  seconds: number
  mode: Mode
  enhance: boolean
  seed?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init)
  if (!r.ok) {
    const body = await r.json().catch(() => null)
    throw new Error(body?.detail ?? `${r.status} ${r.statusText}`)
  }
  return r.json()
}

export const health = () => request<Health>('/health')

export const createJob = (body: GenerationRequest) =>
  request<Job>('/v1/audio/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getJob = (id: string) => request<Job>(`/v1/audio/generations/${id}`)

export async function getAudio(id: string): Promise<Blob> {
  const r = await fetch(`/api/v1/audio/generations/${id}/content`)
  if (!r.ok) throw new Error(`download failed: ${r.status}`)
  return r.blob()
}
