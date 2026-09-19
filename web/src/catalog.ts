// What the studio can make. Shared by the page (labels, examples, tips) and the server
// (validation, model mode, how the audio is processed), so both always agree.

export type Kind = 'sfx' | 'music' | 'voice'

/** How the server turns raw audio into the Godot file (see server/audio.py). */
export type Profile = 'oneshot' | 'ambience' | 'music' | 'track' | 'voice'

export type SfxCategory = {
  id: string
  label: string
  mode: 'SFX' | 'One-shot'
  seconds: number
  loop?: boolean
  example: string
  tip: string
}

export const SFX_CATEGORIES: SfxCategory[] = [
  { id: 'footsteps', label: 'Footsteps', mode: 'SFX', seconds: 2, example: 'Footsteps on wet gravel, heavy boots', tip: 'Say the surface and the shoes.' },
  { id: 'hit', label: 'Hit', mode: 'One-shot', seconds: 1.5, example: 'Heavy sword hitting a wooden shield', tip: 'Say what hits what, and how hard.' },
  { id: 'magic', label: 'Magic', mode: 'SFX', seconds: 3, example: 'Sparkling healing spell with a soft shimmer', tip: 'Describe the feeling: dark, holy, icy, electric…' },
  { id: 'ui', label: 'UI click', mode: 'One-shot', seconds: 1, example: 'Soft wooden button click for a cozy menu', tip: 'Short and simple. Mention the style of the game.' },
  { id: 'creature', label: 'Creature', mode: 'SFX', seconds: 2.5, example: 'Small cute creature chirping happily', tip: 'Say how big it is and what mood it is in.' },
  { id: 'ambience', label: 'Ambience', mode: 'SFX', seconds: 30, loop: true, example: 'Quiet forest at night with crickets and distant owls', tip: 'A background that loops forever. Describe the place and the time of day.' },
  { id: 'other', label: 'Other', mode: 'SFX', seconds: 3, example: 'Wooden treasure chest creaking open', tip: 'Describe the sound in plain words.' },
]

export const MUSIC_LENGTHS = [30, 60, 120]
export const MUSIC_EXAMPLE = 'Calm village theme with acoustic guitar, flute and soft strings, 90 BPM'

export const VOICE_EXAMPLE = 'The bridge is out. You will have to go around through the forest.'
export const DEFAULT_VOICE_LABEL = 'Narrator'

/** Built-in voices: reference clips rendered once with Kokoro-82M (Apache-2.0, synthetic voices,
 * commercial use allowed), which Chatterbox (MIT) then speaks in. Files: /srv/ai/models/voices. */
export const PRESET_VOICES = [
  { id: 'preset_warm_narrator', label: 'Warm narrator' },
  { id: 'preset_calm_narrator', label: 'Calm narrator' },
  { id: 'preset_storyteller', label: 'Storyteller (British)' },
  { id: 'preset_noble_lady', label: 'Noble lady (British)' },
  { id: 'preset_deep_warrior', label: 'Deep warrior' },
  { id: 'preset_old_sage', label: 'Old sage (British)' },
  { id: 'preset_young_hero', label: 'Young hero' },
  { id: 'preset_rogue', label: 'Rogue' },
]

/** Chatterbox "exaggeration": it barely changes below 0.5 and garbles words past ~1.3. */
export const DELIVERY = [
  { label: 'Calm', value: 0.35 },
  { label: 'Normal', value: 0.5 },
  { label: 'Lively', value: 0.8 },
  { label: 'Dramatic', value: 1.15 },
]

export const LYRICS_EXAMPLE = `[verse]
Lanterns glowing on the harbour wall
Sailors singing as the shadows fall

[chorus]
Raise your cup and sing it loud
We are home beneath the cloud`

/** "Calm version": a remix of a music loop that keeps its tempo and loop points, so Godot can
 * crossfade between exploring (calm) and action (the original). Measured on Stable Audio 3: a
 * calmer remix works (quieter, sparser, darker); asking for a *more* intense one barely changes
 * anything, so the original is the intense layer. */
export const INTENSITIES = [
  { id: 'calm', label: 'Calm', prompt: 'calm, soft and gentle, quiet, sparse arrangement, no drums, ambient pads' },
]

export const LANGUAGES: Record<string, string> = {
  en: 'English', ar: 'Arabic', da: 'Danish', de: 'German', el: 'Greek', es: 'Spanish', fi: 'Finnish',
  fr: 'French', he: 'Hebrew', hi: 'Hindi', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay',
  nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ru: 'Russian', sv: 'Swedish',
  sw: 'Swahili', tr: 'Turkish', zh: 'Chinese',
}

export const LIMITS = {
  prompt: 2000,
  line: 500,
  sfxSeconds: [0.5, 30],
  ambienceSeconds: [5, 120],
  musicSeconds: [5, 180],
  loopSeconds: [5, 120], // loops are generated longer than asked, within the model's 180 s
  versions: [1, 4],
  delivery: [0.25, 1.5], // Chatterbox "exaggeration": calm .. dramatic
  lyrics: 3000,
  songSeconds: [10, 240],
}

export function sfxCategory(id: string | undefined): SfxCategory | undefined {
  return SFX_CATEGORIES.find((c) => c.id === id)
}

export function presetVoice(id: string | null | undefined) {
  return PRESET_VOICES.find((v) => v.id === id)
}

export function profileFor(kind: Kind, category: string | undefined, loop: boolean): Profile {
  if (kind === 'voice') return 'voice'
  if (kind === 'music') return loop ? 'music' : 'track'
  return sfxCategory(category)?.loop ? 'ambience' : 'oneshot'
}

/** Godot-friendly file name stem: lowercase words joined by underscores. */
export function slug(text: string, words = 3): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !['a', 'an', 'the', 'with', 'and', 'of', 'on', 'in', 'for'].includes(w))
      .slice(0, words)
      .join('_') || 'sound'
  )
}
