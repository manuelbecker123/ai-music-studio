"""Local API for the Music Studio web app.

Stable Audio 3 and ACE-Step run in ComfyUI. Chatterbox is an optional local
OpenAI-compatible speech service. Metadata and audio stay under server/data.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import random
import re
import shutil
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import audio
from catalog import (
    INTENSITY_PROMPT, LANGUAGE_NAMES, LANGUAGES, LIMITS, PRESET_VOICES,
    SFX_CATEGORIES, SONG_LANGUAGES, profile_for, slug,
)

ROOT = Path(__file__).resolve().parent
WORKFLOWS = ROOT / "workflows"
STABLE = json.loads((WORKFLOWS / "stable_audio_3.json").read_text())
STABLE_REMIX = json.loads((WORKFLOWS / "stable_audio_3_remix.json").read_text())
SONG = json.loads((WORKFLOWS / "ace_step_1_5.json").read_text())
SONG_REFINE = json.loads((WORKFLOWS / "ace_step_1_5_refine.json").read_text())
REQUIRED_MODELS = {
    "checkpoints": ["stable_audio_3_medium.safetensors"],
    "text_encoders": ["t5gemma_b_b_ul2.safetensors", "qwen3.5_2b_bf16.safetensors"],
}
MAX_PENDING = 12
MAX_VOICE_BYTES = 5 * 1024 * 1024
JOB_TIMEOUT = 3600
POLL_SECONDS = 1.0


def unix() -> int:
    return int(time.time())


def between(value: float, bounds: tuple[float, float]) -> bool:
    return value == value and bounds[0] <= value <= bounds[1]


def text_field(body: dict[str, Any], key: str, maximum: int, message: str) -> str:
    value = str(body.get(key, "")).strip()
    if not value:
        raise HTTPException(400, message)
    if len(value) > maximum:
        raise HTTPException(400, f"{key} is too long")
    return value


def safe_name(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip()).strip("_")
    if not value:
        raise HTTPException(400, "name needs at least one letter or number")
    return value[:80]


def public_take(take: dict[str, Any]) -> dict[str, Any]:
    options = take.get("options") or {}
    keys = (
        "id", "group_id", "kind", "category", "profile", "prompt", "seconds",
        "seed", "parent_id", "voice_id", "delivery", "language", "status",
        "revised_prompt", "name", "saved", "game_ext", "duration",
        "created_at", "completed_at",
    )
    result = {key: take.get(key) for key in keys}
    result.update(
        error={"message": take["error"]} if take.get("error") else None,
        lyrics=options.get("lyrics"),
        edited=bool(options.get("edit")),
        intensity=options.get("intensity"),
        song=options.get("engine") == "song",
        translate_to=options.get("translate_to"),
    )
    return result


class Store:
    """JSON metadata plus one folder per take."""

    def __init__(self, root: Path):
        self.root = root
        self.takes_dir = root / "takes"
        root.mkdir(parents=True, exist_ok=True)
        self.takes_dir.mkdir(exist_ok=True)
        self.takes: dict[str, dict[str, Any]] = self._read("takes.json")
        self.voices: dict[str, dict[str, Any]] = self._read("voices.json")

    def _read(self, name: str) -> dict[str, Any]:
        try:
            return json.loads((self.root / name).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _write(self, name: str, value: Any) -> None:
        path = self.root / name
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
        temporary.replace(path)

    def save(self) -> None:
        self._write("takes.json", self.takes)
        self._write("voices.json", self.voices)

    def take_dir(self, take_id: str) -> Path:
        path = self.takes_dir / take_id
        path.mkdir(exist_ok=True)
        return path


@dataclass
class Rendered:
    preview: bytes
    game: bytes
    game_ext: str
    duration: float
    revised_prompt: str | None = None
    source: bytes | None = None
    loop_cut: dict[str, int] | None = None


class RenderEngine(Protocol):
    async def online(self) -> bool: ...
    async def render(
        self, take: dict[str, Any], parent: dict[str, Any] | None, store: Store
    ) -> Rendered: ...
    async def prepare_voice(self, voice_id: str, data: bytes, suffix: str) -> None: ...
    async def delete_voice(self, voice_id: str) -> None: ...


@dataclass
class Settings:
    comfy_url: str = "http://127.0.0.1:8188"
    tts_url: str = "http://127.0.0.1:8506"
    data_dir: Path = ROOT / "data"
    model_voices_dir: Path | None = None
    translator: str = "qwen3.5_9b_bf16.safetensors"
    web_dir: Path | None = ROOT.parent / "web" / "dist"


class LocalModels:
    """Runs the public workflows and prepares game-ready audio."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.voices_dir = settings.model_voices_dir or settings.data_dir / "model-voices"
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.gpu = asyncio.Lock()

    async def _comfy(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.comfy_url, timeout=60
            ) as client:
                response = await client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"ComfyUI is unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise RuntimeError(
                f"ComfyUI {path}: {response.status_code} {response.text[:300]}"
            )
        return response

    async def online(self) -> bool:
        try:
            for folder, names in REQUIRED_MODELS.items():
                have = set((await self._comfy("GET", f"/models/{folder}")).json())
                if any(name not in have for name in names):
                    return False
            return True
        except RuntimeError:
            return False

    @staticmethod
    def _fill(
        workflow: dict[str, Any],
        values: dict[str, Any],
        inputs: dict[str, list[tuple[str, str]]],
    ) -> dict[str, Any]:
        graph = copy.deepcopy(workflow)
        for field, targets in inputs.items():
            if field in values:
                for node, name in targets:
                    graph[node]["inputs"][name] = values[field]
        return graph

    async def _upload(self, data: bytes, prefix: str) -> str:
        response = await self._comfy(
            "POST", "/upload/image",
            files={"image": (f"{prefix}_{uuid.uuid4().hex}.flac", data)},
            data={"overwrite": "true"},
        )
        return response.json()["name"]

    async def _run(
        self, graph: dict[str, Any], output_node: str, text_node: str | None = None
    ) -> tuple[bytes, str | None]:
        async with self.gpu:
            response = await self._comfy(
                "POST", "/prompt", json={"prompt": graph, "client_id": "music-studio"}
            )
            prompt_id = response.json()["prompt_id"]
            deadline = time.monotonic() + JOB_TIMEOUT
            while time.monotonic() < deadline:
                history = (
                    await self._comfy("GET", f"/history/{prompt_id}")
                ).json().get(prompt_id)
                if history:
                    status = history.get("status", {})
                    if status.get("status_str") == "error":
                        errors = [
                            item[1] for item in status.get("messages", [])
                            if item[0] == "execution_error"
                        ]
                        detail = errors[-1].get(
                            "exception_message", errors[-1]
                        ) if errors else status
                        raise RuntimeError(f"workflow failed: {detail}")
                    if status.get("completed"):
                        output = history["outputs"].get(output_node, {})
                        files = [
                            item
                            for key in ("audio", "images", "gifs", "videos")
                            for item in output.get(key, [])
                        ]
                        if not files:
                            raise RuntimeError(
                                f"workflow finished without output on node {output_node}"
                            )
                        item = files[0]
                        content = await self._comfy(
                            "GET", "/view",
                            params={
                                "filename": item["filename"],
                                "subfolder": item.get("subfolder", ""),
                                "type": item.get("type", "output"),
                            },
                        )
                        revised = None
                        if text_node:
                            found = history["outputs"].get(text_node, {}).get("text")
                            revised = found[0] if isinstance(found, list) and found else None
                        return content.content, revised
                await asyncio.sleep(POLL_SECONDS)
        raise RuntimeError("workflow timed out")

    async def _stable(
        self, take: dict[str, Any], seconds: float, reference: bytes | None
    ) -> tuple[bytes, str | None]:
        prompt = take["prompt"]
        if not take["enhance"] and "length:" not in prompt.lower():
            prompt = f"{prompt.rstrip('. ')}. Length: {round(seconds)} seconds"
        values = {
            "prompt": prompt, "seconds": seconds, "enhance": take["enhance"],
            "mode": take["mode"],
            "mode_index": ("Music", "Instrument", "SFX", "One-shot").index(take["mode"]),
            "seed": take["seed"], "prompt_seed": take["prompt_seed"],
        }
        inputs = {
            "prompt": [("52:31", "value")], "seconds": [("52:36", "value")],
            "enhance": [("52:35", "value")], "mode": [("52:43", "choice")],
            "mode_index": [("52:43", "index")], "seed": [("52:3", "seed")],
            "prompt_seed": [("52:28", "sampling_mode.seed")],
        }
        workflow = STABLE
        if reference is not None:
            workflow = STABLE_REMIX
            values.update(
                reference=await self._upload(reference, "music_studio_remix"),
                strength=take["strength"],
            )
            inputs.update(
                reference=[("92", "audio")], strength=[("52:3", "denoise")]
            )
        return await self._run(self._fill(workflow, values, inputs), "19", "90")

    @staticmethod
    def _song_settings(prompt: str) -> dict[str, Any]:
        match = re.search(r"(\d{2,3})\s*bpm", prompt, re.I)
        bpm = int(match.group(1)) if match and 40 <= int(match.group(1)) <= 220 else 100
        notes = (
            "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb",
            "G", "G#", "Ab", "A", "A#", "Bb", "B",
        )
        keys = [f"{note} {scale}" for scale in ("major", "minor") for note in notes]
        key = next((
            item for item in sorted(keys, key=len, reverse=True)
            if re.search(rf"\b{re.escape(item)}\b", prompt, re.I)
        ), None)
        dark = re.search(
            r"\b(dark|sad|melanchol\w*|epic|battle|haunt\w*|tragic|minor|eerie|grim|lonely)\b",
            prompt, re.I,
        )
        return {"bpm": bpm, "keyscale": key or ("A minor" if dark else "C major")}

    async def _song(
        self, take: dict[str, Any], reference: bytes | None
    ) -> tuple[bytes, str | None]:
        values = {
            "prompt": take["prompt"], "seconds": take["seconds"],
            "seed": take["seed"], "lyrics": take["options"]["lyrics"],
            "language": take["language"] if take["language"] in SONG_LANGUAGES else "en",
            **self._song_settings(take["prompt"]),
        }
        inputs = {
            "prompt": [("94", "tags")],
            "seconds": [("94", "duration"), ("98", "seconds")],
            "seed": [("109", "value")], "lyrics": [("94", "lyrics")],
            "language": [("94", "language")], "bpm": [("94", "bpm")],
            "keyscale": [("94", "keyscale")],
        }
        workflow = SONG
        if reference is not None:
            workflow = SONG_REFINE
            values.update(
                reference=await self._upload(reference, "music_studio_song"),
                strength=take["strength"],
            )
            inputs["seconds"] = [("94", "duration"), ("93", "duration")]
            inputs.update(reference=[("92", "audio")], strength=[("3", "denoise")])
        return await self._run(self._fill(workflow, values, inputs), "107")

    async def _translate(self, line: str, language: str) -> str:
        name = LANGUAGE_NAMES[language]
        prompt = (
            f"Translate this line of video game dialogue into {name}. Keep the "
            f"meaning, tone and punctuation, and use natural spoken {name}. "
            f"Reply with only the translation.\n\n{line}"
        )
        graph = {
            "1": {"class_type": "CLIPLoader", "inputs": {
                "clip_name": self.settings.translator,
                "type": "stable_diffusion", "device": "default",
            }},
            "2": {"class_type": "TextGenerate", "inputs": {
                "clip": ["1", 0], "prompt": prompt, "max_length": 512,
                "sampling_mode": "off", "thinking": False,
                "use_default_template": True,
            }},
            "3": {"class_type": "PreviewAny", "inputs": {"source": ["2", 0]}},
        }
        _, result = await self._run(graph, "3", "3")
        if not result:
            raise RuntimeError("translation came back empty")
        return result.strip().strip('"').strip()

    async def _voice(self, take: dict[str, Any], line: str) -> bytes:
        body: dict[str, Any] = {
            "model": "chatterbox-multilingual", "input": line,
            "response_format": "wav", "language": take.get("language") or "en",
            "exaggeration": take["delivery"],
        }
        if take.get("voice_id"):
            voice_id = take["voice_id"]
            body["voice"] = voice_id if voice_id.startswith("preset_") else f"ms_{voice_id}"
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.tts_url, timeout=300
            ) as client:
                response = await client.post("/v1/audio/speech", json=body)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"the voice service is unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise RuntimeError(f"the voice model failed: {response.text[:300]}")
        return response.content

    async def render(
        self, take: dict[str, Any], parent: dict[str, Any] | None, store: Store
    ) -> Rendered:
        options = take.get("options") or {}
        raw: bytes | None = None
        revised: str | None = None
        if options.get("edit"):
            if not parent:
                raise RuntimeError("the original take no longer exists")
            edit = options["edit"]
            finished = (store.take_dir(parent["id"]) / "preview.flac").read_bytes()
            wave, extension = await asyncio.to_thread(
                audio.edit, finished, take["profile"], edit["start"], edit["end"],
                edit["fade_in"], edit["fade_out"],
            )
            revised = parent.get("revised_prompt")
            info: dict[str, Any] = {}
        else:
            reference = None
            if parent and take["kind"] != "voice":
                reference = (store.take_dir(parent["id"]) / "source.flac").read_bytes()
            if take["kind"] == "voice":
                line = take["prompt"]
                if options.get("translate_to"):
                    line = revised = await self._translate(line, options["translate_to"])
                raw = await self._voice(take, line)
            elif options.get("engine") == "song":
                raw, revised = await self._song(take, reference)
            else:
                seconds = audio.generation_seconds(take["profile"], take["seconds"])
                raw, revised = await self._stable(take, seconds, reference)
            match = re.search(r"BPM:\s*(\d+)", revised or "", re.I)
            wave, extension, info = await asyncio.to_thread(
                audio.process, raw, take["profile"], take["seconds"],
                float(match.group(1)) if match else None,
                options.get("loop_cut"),
                reference is not None and options.get("engine") != "song",
            )
        preview = await asyncio.to_thread(audio.encode, wave, "flac")
        game = await asyncio.to_thread(audio.encode, wave, extension)
        return Rendered(
            preview=preview, game=game, game_ext=extension,
            duration=round(wave.shape[1] / audio.SR, 3),
            revised_prompt=revised,
            source=raw if raw is not None and take["kind"] != "voice" else None,
            loop_cut=info.get("loop_cut"),
        )

    async def prepare_voice(self, voice_id: str, data: bytes, suffix: str) -> None:
        target = self.voices_dir / f"ms_{voice_id}.wav"

        def convert() -> None:
            output = subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1",
                    "-ar", "24000", "-t", "20", "-af",
                    "silenceremove=start_periods=1:start_threshold=-45dB",
                    "-f", "wav", "pipe:1",
                ],
                input=data, capture_output=True, check=True,
            ).stdout
            temporary = target.with_suffix(".tmp")
            temporary.write_bytes(output)
            temporary.replace(target)

        await asyncio.to_thread(convert)

    async def delete_voice(self, voice_id: str) -> None:
        (self.voices_dir / f"ms_{voice_id}.wav").unlink(missing_ok=True)


def create_app(
    settings: Settings | None = None, engine: RenderEngine | None = None
) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.data_dir)
    renderer: RenderEngine = engine or LocalModels(settings)
    tasks: dict[str, asyncio.Task[None]] = {}
    queue = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = store
        app.state.renderer = renderer
        yield
        for task in tasks.values():
            if not task.done():
                task.cancel()

    app = FastAPI(title="Music Studio", lifespan=lifespan)

    async def execute(take_id: str) -> None:
        async with queue:
            take = store.takes.get(take_id)
            if not take:
                return
            take["status"] = "in_progress"
            store.save()
            parent = store.takes.get(take.get("parent_id"))
            try:
                result = await renderer.render(take, parent, store)
                folder = store.take_dir(take_id)
                (folder / "preview.flac").write_bytes(result.preview)
                (folder / f"game.{result.game_ext}").write_bytes(result.game)
                if result.source is not None:
                    (folder / "source.flac").write_bytes(result.source)
                take.update(
                    status="completed",
                    revised_prompt=result.revised_prompt,
                    game_ext=result.game_ext,
                    duration=result.duration,
                    completed_at=unix(),
                    error=None,
                )
                if result.loop_cut:
                    take.setdefault("options", {})["loop_cut"] = result.loop_cut
            except asyncio.CancelledError:
                return
            except Exception as exc:
                take.update(
                    status="failed", error=str(exc)[:500], completed_at=unix()
                )
            store.save()

    def schedule(takes: list[dict[str, Any]]) -> None:
        for take in takes:
            task = asyncio.create_task(execute(take["id"]))
            tasks[take["id"]] = task
            task.add_done_callback(
                lambda _task, take_id=take["id"]: tasks.pop(take_id, None)
            )

    def next_names(stem: str, count: int) -> list[str]:
        pattern = re.compile(rf"^{re.escape(stem)}_(\d+)$")
        numbers = [
            int(match.group(1))
            for take in store.takes.values()
            if (match := pattern.match(take["name"]))
        ]
        start = max(numbers, default=0) + 1
        return [f"{stem}_{number:02d}" for number in range(start, start + count)]

    def new_take(
        base: dict[str, Any], name: str, seed: int, group_id: str
    ) -> dict[str, Any]:
        return {
            "id": f"take_{uuid.uuid4().hex}",
            "group_id": group_id,
            "seed": seed,
            "name": name,
            "status": "queued",
            "revised_prompt": None,
            "error": None,
            "saved": False,
            "game_ext": None,
            "duration": None,
            "created_at": unix(),
            "completed_at": None,
            **base,
        }

    def child_take(
        body: dict[str, Any], parent: dict[str, Any], group_id: str
    ) -> tuple[dict[str, Any], str]:
        base = {
            **parent,
            "parent_id": parent["id"],
            "group_id": group_id,
            "created_at": unix(),
        }
        for key in (
            "id", "name", "seed", "status", "revised_prompt", "error",
            "saved", "game_ext", "duration", "completed_at",
        ):
            base.pop(key, None)
        base["options"] = copy.deepcopy(parent.get("options") or {})
        if body.get("edit") is not None:
            supplied = body["edit"]
            if not isinstance(supplied, dict):
                raise HTTPException(400, "edit must contain trim points")
            edit = {
                key: float(supplied.get(key, 0))
                for key in ("start", "end", "fade_in", "fade_out")
            }
            duration = float(parent.get("duration") or 0)
            if not (
                0 <= edit["start"] < edit["end"] <= duration + 0.01
                and edit["end"] - edit["start"] >= 0.05
            ):
                raise HTTPException(400, "those trim points do not fit the sound")
            if not between(edit["fade_in"], (0, 10)) or not between(
                edit["fade_out"], (0, 10)
            ):
                raise HTTPException(400, "fades must be between 0 and 10 seconds")
            if parent["profile"] in ("music", "ambience"):
                raise HTTPException(400, "trimming would break a seamless loop")
            base["strength"] = None
            base["options"]["edit"] = edit
            return base, f"{parent['name']}_edit"
        if body.get("intensity"):
            if parent["profile"] != "music":
                raise HTTPException(400, "calm versions are made from music loops")
            loop_cut = (parent.get("options") or {}).get("loop_cut")
            if not loop_cut:
                raise HTTPException(
                    409, "generate a new loop before making a calm version"
                )
            described = re.sub(
                r"\s*Length:.*$", "",
                parent.get("revised_prompt") or parent["prompt"], flags=re.I,
            )
            base.update(
                prompt=f"{described} {INTENSITY_PROMPT}",
                enhance=False,
                strength=0.8,
            )
            base["options"].update(intensity="Calm", loop_cut=loop_cut)
            return base, parent["name"]
        if parent["kind"] == "voice":
            line = text_field(
                body, "line", LIMITS["line"], "write the line to speak"
            )
            delivery = float(body.get("delivery", parent.get("delivery") or 0.5))
            if not between(delivery, LIMITS["delivery"]):
                raise HTTPException(400, "delivery is out of range")
            base.update(prompt=line, delivery=delivery, strength=None)
            return base, re.sub(r"_\d+$", "", parent["name"])
        difference = float(body.get("difference", 0.5))
        if not between(difference, (0, 1)):
            raise HTTPException(400, "difference must be between 0 and 1")
        direction = str(body.get("direction", "")).strip()
        if len(direction) > 300:
            raise HTTPException(400, "keep the direction under 300 characters")
        original = (
            parent["prompt"]
            if parent["options"].get("engine") == "song"
            else parent.get("revised_prompt") or parent["prompt"]
        )
        described = re.sub(r"\s*Length:.*$", "", original, flags=re.I)
        if direction:
            base.update(
                prompt=f"{described.rstrip('. ')}. {direction}", enhance=False
            )
        base["strength"] = 0.3 + 0.55 * difference
        return base, re.sub(r"_\d+$", "", parent["name"])

    def root_take(
        body: dict[str, Any], seed: int
    ) -> tuple[dict[str, Any], str, int]:
        kind = body.get("kind")
        if kind not in ("sfx", "music", "voice"):
            raise HTTPException(400, "kind must be sfx, music or voice")
        prompt = text_field(
            body,
            "prompt",
            LIMITS["line" if kind == "voice" else "prompt"],
            "write the line to speak" if kind == "voice" else "describe the sound",
        )
        enhance = body.get("enhance", True)
        if not isinstance(enhance, bool):
            raise HTTPException(400, "enhance must be true or false")
        common = {
            "kind": kind, "prompt": prompt, "parent_id": None,
            "strength": None, "voice_id": None, "delivery": None,
            "language": None, "category": None, "options": {},
            "prompt_seed": seed,
        }
        if kind == "sfx":
            category = str(body.get("category", "other"))
            if category not in SFX_CATEGORIES:
                raise HTTPException(400, "unknown sound category")
            info = SFX_CATEGORIES[category]
            seconds = float(body.get("seconds", info["seconds"]))
            bounds = LIMITS[
                "ambience_seconds" if info["loop"] else "sfx_seconds"
            ]
            if not between(seconds, bounds):
                raise HTTPException(400, "that length is out of range")
            count = int(body.get("versions", 1))
            if count not in (1, 4):
                raise HTTPException(400, "versions must be 1 or 4")
            if info["loop"]:
                count = 1
            base = {
                **common, "category": category,
                "profile": profile_for(kind, category),
                "seconds": seconds, "mode": info["mode"], "enhance": enhance,
            }
            stem = (
                f"sfx_{category}" if category != "other"
                else f"sfx_{slug(prompt, 2)}"
            )
            return base, stem, count
        if kind == "music" and body.get("vocals"):
            lyrics = text_field(
                body, "lyrics", LIMITS["lyrics"],
                "write some lyrics, or turn Vocals off",
            )
            seconds = float(body.get("seconds", 120))
            if not between(seconds, LIMITS["song_seconds"]):
                raise HTTPException(400, "that length is out of range")
            language = str(body.get("language", "en"))
            if language not in LANGUAGES:
                raise HTTPException(400, "unsupported language")
            base = {
                **common, "profile": "track", "seconds": seconds,
                "mode": "Song", "enhance": False, "language": language,
                "options": {"engine": "song", "lyrics": lyrics},
            }
            return base, f"song_{slug(prompt, 2)}", 1
        if kind == "music":
            loop = body.get("loop", True)
            if not isinstance(loop, bool):
                raise HTTPException(400, "loop must be true or false")
            seconds = float(body.get("seconds", 30))
            if not between(
                seconds, LIMITS["loop_seconds" if loop else "music_seconds"]
            ):
                raise HTTPException(400, "that length is out of range")
            base = {
                **common, "profile": profile_for(kind, loop=loop),
                "seconds": seconds, "mode": "Music", "enhance": enhance,
            }
            return base, f"music_{slug(prompt, 2)}", 1
        voice_id = str(body.get("voice_id", "")) or None
        if (
            voice_id
            and voice_id not in PRESET_VOICES
            and voice_id not in store.voices
        ):
            raise HTTPException(400, "that voice no longer exists")
        delivery = float(body.get("delivery", 0.5))
        if not between(delivery, LIMITS["delivery"]):
            raise HTTPException(400, "delivery is out of range")
        language = str(body.get("language", "en"))
        translate_to = str(body.get("translate_to", "")) or None
        if language not in LANGUAGES or (
            translate_to and translate_to not in LANGUAGES
        ):
            raise HTTPException(400, "unsupported language")
        options = {"translate_to": translate_to} if translate_to else {}
        base = {
            **common, "profile": "voice", "seconds": 0, "mode": "Voice",
            "enhance": False, "voice_id": voice_id, "delivery": delivery,
            "language": translate_to or language, "options": options,
        }
        voice_name = store.voices.get(voice_id or "", {"name": "voice"})["name"]
        return base, f"voice_{slug(voice_name, 2)}", 1

    def create_takes(body: dict[str, Any]) -> list[dict[str, Any]]:
        pending = sum(
            take["status"] in ("queued", "in_progress")
            for take in store.takes.values()
        )
        if pending >= MAX_PENDING:
            raise HTTPException(
                429, f"{pending} sounds are already waiting; try again later"
            )
        requested = body.get("seed")
        if requested is not None and (
            not isinstance(requested, int) or not 0 <= requested <= 2**53
        ):
            raise HTTPException(400, "seed must be a positive whole number")
        seed = requested if requested is not None else random.randrange(2**31)
        group_id = f"group_{uuid.uuid4().hex}"
        parent_id = str(body.get("parent_id", "")) or None
        if parent_id:
            parent = store.takes.get(parent_id)
            if not parent or parent["status"] != "completed":
                raise HTTPException(404, "that take is not available")
            base, stem = child_take(body, parent, group_id)
            count = 1
        else:
            base, stem, count = root_take(body, seed)
        names = next_names(stem, count)
        takes = [
            new_take(base, names[index], seed + index, group_id)
            for index in range(count)
        ]
        store.takes.update({take["id"]: take for take in takes})
        store.save()
        return takes

    def get_take(take_id: str) -> dict[str, Any]:
        take = store.takes.get(take_id)
        if not take:
            raise HTTPException(404, "no such take")
        return take

    @app.get("/api/status")
    async def status():
        return {"agent_online": await renderer.online()}

    @app.get("/api/health")
    async def health():
        online = await renderer.online()
        return {"comfyui": online, "missing_models": []}

    @app.get("/api/takes")
    async def recent():
        cutoff = unix() - 86400
        takes = [
            public_take(take)
            for take in store.takes.values()
            if take["created_at"] >= cutoff
        ]
        return {
            "takes": sorted(
                takes, key=lambda take: (-take["created_at"], take["name"])
            )
        }

    @app.get("/api/library")
    async def library():
        takes = [
            public_take(take)
            for take in store.takes.values()
            if take["saved"] and take["status"] == "completed"
        ]
        return {
            "takes": sorted(
                takes, key=lambda take: (-take["created_at"], take["name"])
            )
        }

    @app.post("/api/takes")
    async def create(request: Request):
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be an object")
        takes = create_takes(body)
        schedule(takes)
        return {"takes": [public_take(take) for take in takes]}

    @app.get("/api/takes/{take_id}")
    async def one(take_id: str):
        return public_take(get_take(take_id))

    @app.patch("/api/takes/{take_id}")
    async def update(take_id: str, request: Request):
        take = get_take(take_id)
        body = await request.json()
        if "name" in body:
            take["name"] = safe_name(str(body["name"]))
        if "saved" in body:
            if not isinstance(body["saved"], bool):
                raise HTTPException(400, "saved must be true or false")
            take["saved"] = body["saved"]
        store.save()
        return public_take(take)

    @app.delete("/api/takes/{take_id}")
    async def remove(take_id: str):
        get_take(take_id)
        task = tasks.pop(take_id, None)
        if task:
            task.cancel()
        store.takes.pop(take_id)
        shutil.rmtree(store.takes_dir / take_id, ignore_errors=True)
        store.save()
        return {"ok": True}

    @app.get("/api/takes/{take_id}/preview")
    async def preview(take_id: str):
        take = get_take(take_id)
        path = store.take_dir(take_id) / "preview.flac"
        if take["status"] != "completed" or not path.exists():
            raise HTTPException(409, f"audio is {take['status']}")
        return FileResponse(path, media_type="audio/flac")

    @app.get("/api/takes/{take_id}/file")
    async def game_file(take_id: str):
        take = get_take(take_id)
        extension = take.get("game_ext")
        path = store.take_dir(take_id) / f"game.{extension}"
        if take["status"] != "completed" or not extension or not path.exists():
            raise HTTPException(409, f"audio is {take['status']}")
        media_type = "audio/ogg" if extension == "ogg" else "audio/wav"
        return FileResponse(
            path, media_type=media_type, filename=f"{take['name']}.{extension}"
        )

    @app.get("/api/voices")
    async def voices():
        values = [
            {"id": voice["id"], "name": voice["name"]}
            for voice in store.voices.values()
        ]
        return {
            "voices": sorted(values, key=lambda voice: voice["name"].lower())
        }

    @app.post("/api/voices")
    async def add_voice(
        name: str = Form("Narrator"), audio_file: UploadFile = File(alias="audio")
    ):
        clean_name = name.strip()[:40]
        if not clean_name:
            raise HTTPException(400, "name is required")
        data = await audio_file.read(MAX_VOICE_BYTES + 1)
        if not data or len(data) > MAX_VOICE_BYTES:
            raise HTTPException(400, "use a recording smaller than 5 MB")
        voice_id = f"voice_{uuid.uuid4().hex}"
        suffix = (
            Path(audio_file.filename or "recording.wav").suffix.lower() or ".wav"
        )
        await renderer.prepare_voice(voice_id, data, suffix)
        for old_id, old in list(store.voices.items()):
            if old["name"].strip().lower() == clean_name.lower():
                await renderer.delete_voice(old_id)
                del store.voices[old_id]
        voice = {"id": voice_id, "name": clean_name, "created_at": unix()}
        store.voices[voice_id] = voice
        store.save()
        return {"id": voice_id, "name": clean_name}

    @app.delete("/api/voices/{voice_id}")
    async def delete_voice(voice_id: str):
        if voice_id not in store.voices:
            raise HTTPException(404, "no such voice")
        await renderer.delete_voice(voice_id)
        del store.voices[voice_id]
        store.save()
        return {"ok": True}

    if settings.web_dir and settings.web_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Music Studio server")
    parser.add_argument(
        "--comfy-url", default=os.environ.get("COMFY_URL", Settings.comfy_url)
    )
    parser.add_argument(
        "--tts-url", default=os.environ.get("TTS_URL", Settings.tts_url)
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("DATA_DIR", ROOT / "data")),
    )
    parser.add_argument(
        "--voices-dir", type=Path, default=os.environ.get("VOICES_DIR")
    )
    parser.add_argument(
        "--translator",
        default=os.environ.get("TRANSLATOR_MODEL", Settings.translator),
    )
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", "8000"))
    )
    args = parser.parse_args()
    settings = Settings(
        comfy_url=args.comfy_url,
        tts_url=args.tts_url,
        data_dir=args.data_dir,
        model_voices_dir=args.voices_dir,
        translator=args.translator,
    )
    uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
