#!/usr/bin/env bash
# Downloads the Stable Audio 3 models into a ComfyUI install. Pass --all to
# include ACE-Step 1.5 songs and the Qwen 3.5 translation model.
#
#   scripts/download-models.sh /path/to/ComfyUI [--all]
#
# Files are pinned to exact Hugging Face revisions so every clone gets the same weights.
# Interrupted downloads resume. Core is about 15 GB; --all is about 54 GB.
set -euo pipefail

COMFY="${1:-}"
ALL="${2:-}"
if [[ -z "$COMFY" || ! -d "$COMFY/models" ]]; then
  echo "usage: $0 /path/to/ComfyUI [--all]   (the folder that contains models/)" >&2
  exit 1
fi
if [[ -n "$ALL" && "$ALL" != "--all" ]]; then
  echo "unknown option: $ALL" >&2
  exit 1
fi

HF="https://huggingface.co"
SA3="Comfy-Org/stable-audio-3/resolve/96fc663283cde94cb631bc84f6c9ece7bbe2bf25"
QWEN="Comfy-Org/Qwen3.5/resolve/5d50a2252bf1bcd49e5fee9b5f296986d442682b"
ACE="Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/694a9723ff772285c73f0700caacf944d3f02f8d"

# destination (under models/)           source
FILES=(
  "checkpoints/stable_audio_3_medium.safetensors $SA3/checkpoints/stable_audio_3_medium.safetensors"
  "text_encoders/t5gemma_b_b_ul2.safetensors     $SA3/text_encoders/t5gemma_b_b_ul2.safetensors"
  "text_encoders/qwen3.5_2b_bf16.safetensors     $QWEN/text_encoders/qwen3.5_2b_bf16.safetensors"
)

if [[ "$ALL" == "--all" ]]; then
  FILES+=(
    "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors $ACE/split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors"
    "text_encoders/qwen_0.6b_ace15.safetensors                $ACE/split_files/text_encoders/qwen_0.6b_ace15.safetensors"
    "text_encoders/qwen_4b_ace15.safetensors                  $ACE/split_files/text_encoders/qwen_4b_ace15.safetensors"
    "vae/ace_1.5_vae.safetensors                              $ACE/split_files/vae/ace_1.5_vae.safetensors"
    "text_encoders/qwen3.5_9b_bf16.safetensors                $QWEN/text_encoders/qwen3.5_9b_bf16.safetensors"
  )
fi

for entry in "${FILES[@]}"; do
  read -r dest src <<<"$entry"
  target="$COMFY/models/$dest"
  mkdir -p "$(dirname "$target")"
  size=$(curl -sIL "$HF/$src" | awk 'tolower($1)=="content-length:" {n=$2} END {gsub("\r","",n); print n}')
  if [[ -f "$target" && -n "$size" && "$(wc -c <"$target")" -eq "$size" ]]; then
    echo "ok        $dest"
    continue
  fi
  echo "download  $dest ($((size / 1024 / 1024)) MB)"
  curl -fL --retry 5 -C - -o "$target.part" "$HF/$src"
  mv "$target.part" "$target"
done

echo "Done. Restart ComfyUI (or refresh its model list) so it sees the new files."
