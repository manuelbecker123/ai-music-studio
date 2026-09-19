// Decoding previews for the player and the trim editor: one shared AudioContext and cache.

let context: AudioContext | null = null
const buffers = new Map<string, Promise<AudioBuffer>>()

export function audioContext() {
  context ??= new AudioContext()
  return context
}

/** The browser's own decoder first; Safari cannot decode FLAC, so fall back to a WASM decoder
 * (loaded only when needed). */
async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = audioContext()
  try {
    return await ctx.decodeAudioData(data.slice(0))
  } catch {
    const { FLACDecoder } = await import('@wasm-audio-decoders/flac')
    const decoder = new FLACDecoder()
    await decoder.ready
    const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(new Uint8Array(data))
    decoder.free()
    if (!samplesDecoded) throw new Error('could not decode audio')
    const buffer = ctx.createBuffer(channelData.length, samplesDecoded, sampleRate)
    channelData.forEach((ch, i) => buffer.copyToChannel(new Float32Array(ch), i))
    return buffer
  }
}

export function load(url: string): Promise<AudioBuffer> {
  if (!buffers.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`could not load audio (${r.status})`)
        return r.arrayBuffer()
      })
      .then((data) => decode(data))
    p.catch(() => buffers.delete(url))
    buffers.set(url, p)
  }
  return buffers.get(url)!
}
