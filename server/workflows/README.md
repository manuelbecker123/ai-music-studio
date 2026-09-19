# Workflows

`stable_audio_3.json` is ComfyUI's official Stable Audio 3 text-to-audio template
([Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates), MIT),
exported in API format. Two changes from the template:

- node `19` (Save Audio) writes to `output/music-studio/`
- node `90` (Preview Any) was added so the server can report the prompt the model received
  after the optional prompt enhancer rewrote it

The server fills these inputs per request (see `NODES` in `server/app.py`):

| Field | Node | Input |
|---|---|---|
| prompt | `52:31` | `value` |
| seconds | `52:36` | `value` |
| enhance | `52:35` | `value` |
| mode | `52:43` | `choice`, `index` |
| seed | `52:3`, `52:28` | `seed`, `sampling_mode.seed` |

To use a different graph, export it from ComfyUI with *Workflow → Export (API)* and update
`NODES` to match its node ids.
