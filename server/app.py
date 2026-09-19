"""Music Studio server: a small job API in front of ComfyUI's Stable Audio 3 workflow.

    POST /api/v1/audio/generations          queue a job   {prompt, seconds?, mode?, enhance?, seed?}
    GET  /api/v1/audio/generations/{id}     job status    queued | in_progress | completed | failed
    GET  /api/v1/audio/generations/{id}/content   the MP3 once completed
    GET  /api/health                        whether ComfyUI is reachable and has the models

Jobs are asynchronous because a long clip can take longer than a browser or proxy is willing
to wait on one request. They live in memory and are dropped an hour after they finish.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictBool, field_validator

ROOT = Path(__file__).resolve().parent
WORKFLOW = json.loads((ROOT / "workflows" / "stable_audio_3.json").read_text())

MODES = ("Music", "Instrument", "SFX", "One-shot")  # the template's prompt-enhancer presets, in order
MAX_SECONDS = 180  # the template defaults to 150; longer clips are untested
MAX_PROMPT = 2000
MAX_PENDING = 8
KEEP_SECONDS = 3600
JOB_TIMEOUT = 3600  # includes time spent waiting behind other ComfyUI jobs

# Where each request field goes in the workflow: [(node id, input name), ...]
NODES = {
    "prompt": [("52:31", "value")],
    "seconds": [("52:36", "value")],
    "enhance": [("52:35", "value")],
    "mode": [("52:43", "choice")],
    "mode_index": [("52:43", "index")],
    "seed": [("52:3", "seed"), ("52:28", "sampling_mode.seed")],
}
OUTPUT_NODE = "19"  # Save Audio (MP3)
PROMPT_NODE = "90"  # Preview Any: the prompt after the enhancer
LENGTH_TAG = "Length: {seconds} seconds"  # the enhancer appends this; raw prompts need it added

REQUIRED_MODELS = {
    "checkpoints": ["stable_audio_3_medium.safetensors"],
    "text_encoders": ["t5gemma_b_b_ul2.safetensors", "qwen3.5_2b_bf16.safetensors"],
}


# ---------------------------------------------------------------- requests and jobs

class GenerationRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT)
    seconds: float = Field(default=30, ge=0.5, le=MAX_SECONDS)
    mode: str = "Music"
    enhance: StrictBool = True
    seed: int | None = Field(default=None, ge=0, le=2**53)

    @field_validator("prompt")
    @classmethod
    def _strip(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("prompt is required")
        return v.strip()

    @field_validator("mode")
    @classmethod
    def _mode(cls, v: str) -> str:
        for m in MODES:
            if m.lower() == v.lower():
                return m
        raise ValueError(f"mode must be one of {', '.join(MODES)}")


Status = Literal["queued", "in_progress", "completed", "failed"]


@dataclass
class Job:
    id: str
    request: GenerationRequest
    seed: int
    status: Status = "queued"
    revised_prompt: str | None = None
    error: str | None = None
    created_at: int = 0
    completed_at: int | None = None
    audio: bytes | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "object": "audio.generation",
            "status": self.status,
            "seconds": self.request.seconds,
            "mode": self.request.mode,
            "seed": self.seed,
            "revised_prompt": self.revised_prompt,
            "error": {"message": self.error} if self.error else None,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


def build_graph(req: GenerationRequest, seed: int) -> dict:
    """The workflow with this request's values filled in."""
    prompt = req.prompt
    if not req.enhance and "length:" not in prompt.lower():
        prompt = f"{prompt.rstrip('. ')}. {LENGTH_TAG.format(seconds=round(req.seconds))}"
    values = {
        "prompt": prompt,
        "seconds": req.seconds,
        "enhance": req.enhance,
        "mode": req.mode,
        "mode_index": MODES.index(req.mode),
        "seed": seed,
    }
    graph = copy.deepcopy(WORKFLOW)
    for field, targets in NODES.items():
        for node, name in targets:
            graph[node]["inputs"][name] = values[field]
    return graph


# ---------------------------------------------------------------- ComfyUI

class ComfyError(Exception):
    pass


class Comfy:
    """The few ComfyUI endpoints this server uses."""

    def __init__(self, client: httpx.AsyncClient):
        self.http = client

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = await self.http.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise ComfyError(f"ComfyUI unreachable: {e}") from e
        if r.status_code >= 400:
            raise ComfyError(f"ComfyUI {path}: {r.status_code} {r.text[:300]}")
        return r

    async def submit(self, graph: dict) -> str:
        r = await self._request("POST", "/prompt", json={"prompt": graph, "client_id": "music-studio"})
        return r.json()["prompt_id"]

    async def history(self, prompt_id: str) -> dict | None:
        return (await self._request("GET", f"/history/{prompt_id}")).json().get(prompt_id)

    async def fetch(self, f: dict) -> bytes:
        params = {"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
        return (await self._request("GET", "/view", params=params)).content

    async def models(self, folder: str) -> list[str]:
        return (await self._request("GET", f"/models/{folder}")).json()

    async def busy(self) -> bool:
        q = (await self._request("GET", "/queue")).json()
        return bool(q.get("queue_running") or q.get("queue_pending"))

    async def free(self) -> None:
        await self._request("POST", "/free", json={"unload_models": True, "free_memory": True})


async def run_job(comfy: Comfy, job: Job, poll: float = 1.0) -> None:
    """Runs one job on ComfyUI and stores the result on the job."""
    prompt_id = await comfy.submit(build_graph(job.request, job.seed))
    job.status = "in_progress"
    deadline = time.monotonic() + JOB_TIMEOUT
    while time.monotonic() < deadline:
        hist = await comfy.history(prompt_id)
        status = (hist or {}).get("status", {})
        if status.get("status_str") == "error":
            errors = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
            detail = errors[-1].get("exception_message", errors[-1]) if errors else status
            raise ComfyError(f"workflow failed: {detail}")
        if status.get("completed"):
            outputs = hist["outputs"]
            files = outputs.get(OUTPUT_NODE, {}).get("audio", [])
            if not files:
                raise ComfyError("workflow finished without audio")
            text = outputs.get(PROMPT_NODE, {}).get("text")
            job.revised_prompt = text[0] if isinstance(text, list) and text else None
            job.audio = await comfy.fetch(files[0])
            return
        await asyncio.sleep(poll)
    raise ComfyError("workflow timed out")


# ---------------------------------------------------------------- app

@dataclass
class Settings:
    comfy_url: str = "http://127.0.0.1:8188"
    unload_after: float = 0  # seconds idle before ComfyUI is asked to unload models; 0 = never
    web_dir: Path | None = ROOT.parent / "web" / "dist"


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    jobs: dict[str, Job] = {}
    gpu = asyncio.Lock()  # one generation at a time, in submission order
    state = {"last_finished": None}

    async def idle_unloader(comfy: Comfy) -> None:
        while True:
            await asyncio.sleep(min(10, settings.unload_after))
            last = state["last_finished"]
            pending = any(j.status in ("queued", "in_progress") for j in jobs.values())
            if last is None or pending or time.monotonic() - last < settings.unload_after:
                continue
            try:
                if not await comfy.busy():  # never unload under someone else's running workflow
                    await comfy.free()
                    state["last_finished"] = None
            except ComfyError:
                pass

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(base_url=settings.comfy_url, timeout=60, transport=transport) as client:
            app.state.comfy = Comfy(client)
            task = asyncio.create_task(idle_unloader(app.state.comfy)) if settings.unload_after > 0 else None
            yield
            if task:
                task.cancel()

    app = FastAPI(title="Music Studio", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        err = exc.errors()[0]
        field = ".".join(str(p) for p in err["loc"][1:]) or "body"
        msg = err["msg"].removeprefix("Value error, ")
        return JSONResponse({"detail": f"{field}: {msg}"}, status_code=400)

    def prune() -> None:
        cutoff = time.time() - KEEP_SECONDS
        for jid in [j.id for j in jobs.values() if j.completed_at and j.completed_at < cutoff]:
            del jobs[jid]

    async def execute(job: Job) -> None:
        async with gpu:
            try:
                await run_job(app.state.comfy, job)
                job.status = "completed"
            except Exception as e:  # reported through the job's status
                job.status, job.error = "failed", str(e)
            finally:
                job.completed_at = int(time.time())
                state["last_finished"] = time.monotonic()

    @app.get("/api/health")
    async def health():
        try:
            missing = [f"{folder}/{name}" for folder, names in REQUIRED_MODELS.items()
                       for name in names if name not in await app.state.comfy.models(folder)]
        except ComfyError:
            return {"comfyui": False, "missing_models": []}
        return {"comfyui": True, "missing_models": missing}

    @app.post("/api/v1/audio/generations")
    async def create(req: GenerationRequest):
        prune()
        pending = sum(j.status in ("queued", "in_progress") for j in jobs.values())
        if pending >= MAX_PENDING:
            raise HTTPException(429, f"{pending} jobs already waiting; try again later")
        seed = req.seed if req.seed is not None else random.randrange(2**31)
        job = Job(id=f"audio_{uuid.uuid4().hex}", request=req, seed=seed, created_at=int(time.time()))
        jobs[job.id] = job
        asyncio.create_task(execute(job))
        return job.public()

    def get_job(jid: str) -> Job:
        if jid not in jobs:
            raise HTTPException(404, "no such audio job")
        return jobs[jid]

    @app.get("/api/v1/audio/generations/{jid}")
    async def status(jid: str):
        return get_job(jid).public()

    @app.get("/api/v1/audio/generations/{jid}/content")
    async def content(jid: str):
        job = get_job(jid)
        if job.status != "completed":
            raise HTTPException(409, f"audio is {job.status}")
        return Response(job.audio, media_type="audio/mpeg",
                        headers={"Content-Disposition": f'attachment; filename="{jid}.mp3"'})

    if settings.web_dir and settings.web_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app


def main() -> None:
    p = argparse.ArgumentParser(description="Music Studio server")
    p.add_argument("--comfy-url", default=os.environ.get("COMFY_URL", Settings.comfy_url))
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    p.add_argument("--unload-after", type=float, default=float(os.environ.get("UNLOAD_AFTER", "0")),
                   help="seconds idle before ComfyUI unloads its models (0 = never)")
    a = p.parse_args()
    app = create_app(Settings(comfy_url=a.comfy_url, unload_after=a.unload_after))
    uvicorn.run(app, host=a.host, port=a.port)


if __name__ == "__main__":
    main()
