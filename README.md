# Music Studio

A small web app for making music loops, instrument parts and sound effects with
[Stable Audio 3](https://huggingface.co/stabilityai/stable-audio-3-medium), running entirely
on your own machine through [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

![Music Studio](docs/screenshot.png)

**Sample:** [docs/sample.mp3](docs/sample.mp3). This is 20 seconds of *"Warm lofi hip hop loop,
dusty rhodes chords, soft vinyl crackle, laid-back drums, 80 BPM"* in Music mode with seed 2026.

## How it works

```
browser ──> web/ (React) ──> server/ (FastAPI, :8000) ──> ComfyUI (:8188) ──> Stable Audio 3
```

The server fills ComfyUI's official Stable Audio 3 workflow with your prompt, queues it, and
hands back the MP3. An optional prompt enhancer (Qwen 3.5 2B) rewrites short ideas into the
detailed descriptions the model responds to best.

## Requirements

- **ComfyUI 0.28 or newer** (tested with 0.28.2). Install it from
  [its README](https://github.com/comfyanonymous/ComfyUI#installing) or use ComfyUI Desktop.
- **A GPU.** Generating uses about 8 GB of GPU memory. It is tested on NVIDIA with CUDA.
  Apple Silicon may work through ComfyUI's MPS support but is untested. CPU-only is very slow.
- **About 15 GB of disk** for the models.
- **Python 3.10+** and **Node.js 20+**.

## Setup

**1. Start ComfyUI** and leave it running (default `http://127.0.0.1:8188`).

**2. Download the models** into your ComfyUI folder (the one that contains `models/`), then
restart ComfyUI:

```sh
scripts/download-models.sh /path/to/ComfyUI
```

Or download them by hand:

| File | Folder | Size |
|---|---|---|
| [stable_audio_3_medium.safetensors](https://huggingface.co/Comfy-Org/stable-audio-3/blob/main/checkpoints/stable_audio_3_medium.safetensors) | `models/checkpoints/` | 9.2 GB |
| [t5gemma_b_b_ul2.safetensors](https://huggingface.co/Comfy-Org/stable-audio-3/blob/main/text_encoders/t5gemma_b_b_ul2.safetensors) | `models/text_encoders/` | 1.2 GB |
| [qwen3.5_2b_bf16.safetensors](https://huggingface.co/Comfy-Org/Qwen3.5/blob/main/text_encoders/qwen3.5_2b_bf16.safetensors) | `models/text_encoders/` | 4.5 GB |

**3. Install and start Music Studio:**

```sh
git clone https://github.com/manuelbecker123/ai-music-studio.git
cd ai-music-studio

python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt   # Windows: server\.venv\Scripts\pip

(cd web && npm ci && npm run build)

server/.venv/bin/python server/app.py
```

Open **http://127.0.0.1:8000**. The top right corner shows **Ready** once ComfyUI is reachable
and has all three models. If one is missing, the page names it.

### Options

| Flag | Environment | Default | |
|---|---|---|---|
| `--comfy-url` | `COMFY_URL` | `http://127.0.0.1:8188` | where ComfyUI runs |
| `--host` | `HOST` | `127.0.0.1` | interface to listen on |
| `--port` | `PORT` | `8000` | |
| `--unload-after` | `UNLOAD_AFTER` | `0` (never) | seconds idle before ComfyUI unloads its models to free GPU memory |

## Using it

- **Modes** pick how the prompt enhancer writes the description:
  - **Music**: full tracks.
  - **Instrument**: a single part or loop.
  - **SFX**: a sound effect with silence around it.
  - **One-shot**: a single hit that starts immediately, such as a drum or a stab.
- **Length** runs from 0.5 to 180 seconds. The model follows it closely.
- **Enhance prompt** turns a few words into a detailed description; the rewritten prompt is shown
  under each take. Turn it off to send your prompt exactly as written. Good raw prompts name the
  genre, the instruments, the mood and the tempo (`BPM: 90`).
- **Seed**: the same prompt, settings and seed give the same audio. *Reuse seed* on a take lets
  you vary the prompt while keeping the rest.

## API

The UI is a thin client over a small JSON API, which you can script directly:

```sh
curl -s localhost:8000/api/v1/audio/generations -H 'content-type: application/json' \
  -d '{"prompt": "glass shattering", "seconds": 3, "mode": "SFX"}'
# -> {"id": "audio_…", "status": "queued", …}
curl -s localhost:8000/api/v1/audio/generations/audio_…            # poll until "completed"
curl -s localhost:8000/api/v1/audio/generations/audio_…/content -o out.mp3
```

Jobs are kept in memory for an hour after they finish. ComfyUI also saves every result under
its `output/music-studio/` folder.

## Development

```sh
server/.venv/bin/python server/app.py   # API on :8000
cd web && npm install && npm run dev    # UI on :5173 with hot reload; /api is proxied to :8000
```

Tests use a fake ComfyUI, so they need no GPU:

```sh
cd server && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

`server/workflows/README.md` explains how the workflow maps to request fields if you want to
swap in your own graph.

## Security

The server has no authentication and listens on localhost only. Don't expose it to a network
you don't trust without putting authentication in front of it.

## License

The code is [MIT](LICENSE). The workflow is adapted from
[ComfyUI's templates](https://github.com/Comfy-Org/workflow_templates) (MIT). Stable Audio 3 is
released under the
[Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-3-medium).
Read it before using the model or its output commercially.
