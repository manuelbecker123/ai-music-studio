# ComfyUI workflows

These API-format graphs come from ComfyUI's official templates and are filled by
`server/app.py`. Node ids that look like `52:31` are nodes inside the Stable
Audio template's subgraph.

## Stable Audio 3

`stable_audio_3.json` generates a new sound. The server fills:

| Request value | Node input |
|---|---|
| prompt | `52:31.value` |
| duration | `52:36.value` |
| prompt enhancement | `52:35.value` |
| Music / Instrument / SFX / One-shot | `52:43.choice`, `52:43.index` |
| audio seed | `52:3.seed` |
| prompt seed | `52:28.sampling_mode.seed` |

Node `19` exposes lossless audio and node `90` exposes the rewritten prompt.

`stable_audio_3_remix.json` replaces the empty latent with a reference clip:
the server uploads FLAC through ComfyUI's input endpoint, writes its name to
`92.audio`, and maps Similar/Different to `52:3.denoise`. It is used by
Refine and Calm version.

## ACE-Step 1.5

`ace_step_1_5.json` makes a complete song. Node `94` receives the style tags,
lyrics, language, duration, BPM and key; node `109` receives the seed; node
`107` exposes lossless audio.

`ace_step_1_5_refine.json` loads a parent song at node `92`, trims it to the
requested duration at node `93`, encodes it, and maps remix strength to
`3.denoise`.

The model filenames referenced by each graph match
`scripts/download-models.sh --all`.

## Re-exporting

If a ComfyUI template changes, open it in ComfyUI, use **Workflow → Export
(API)**, preserve the output and prompt-preview nodes described above, and
update the mappings in `LocalModels._stable` or `LocalModels._song`.
