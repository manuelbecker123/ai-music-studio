import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import app as server


class FakeComfy:
    """Answers the ComfyUI endpoints the server uses."""

    def __init__(self, outcome="success", models=None):
        self.outcome = outcome
        self.models = models if models is not None else server.REQUIRED_MODELS
        self.graphs = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/prompt":
            self.graphs.append(json.loads(request.content)["prompt"])
            return httpx.Response(200, json={"prompt_id": f"p{len(self.graphs)}"})
        if path.startswith("/history/"):
            pid = path.rsplit("/", 1)[1]
            if self.outcome == "pending":
                return httpx.Response(200, json={})
            if self.outcome == "error":
                status = {"status_str": "error", "completed": False,
                          "messages": [["execution_error", {"exception_message": "out of memory"}]]}
                return httpx.Response(200, json={pid: {"status": status, "outputs": {}}})
            outputs = {server.OUTPUT_NODE: {"audio": [{"filename": "a.mp3", "subfolder": "", "type": "output"}]},
                       server.PROMPT_NODE: {"text": ["an enhanced prompt"]}}
            return httpx.Response(200, json={pid: {"status": {"status_str": "success", "completed": True},
                                                   "outputs": outputs}})
        if path == "/view":
            return httpx.Response(200, content=b"ID3-fake-mp3")
        if path.startswith("/models/"):
            return httpx.Response(200, json=self.models.get(path.rsplit("/", 1)[1], []))
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def fast_poll(monkeypatch):
    monkeypatch.setattr(server, "POLL_SECONDS", 0.01)


def client(fake: FakeComfy) -> TestClient:
    app = server.create_app(server.Settings(web_dir=None), transport=httpx.MockTransport(fake))
    return TestClient(app)


def wait(c: TestClient, jid: str) -> dict:
    for _ in range(200):
        job = c.get(f"/api/v1/audio/generations/{jid}").json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


# ---------------------------------------------------------------- workflow

def test_build_graph_fills_every_mapped_input():
    req = server.GenerationRequest(prompt="warm pads", seconds=12, mode="sfx", enhance=True, seed=42)
    graph = server.build_graph(req, 42)
    assert graph["52:31"]["inputs"]["value"] == "warm pads"
    assert graph["52:36"]["inputs"]["value"] == 12
    assert graph["52:43"]["inputs"]["choice"] == "SFX"
    assert graph["52:43"]["inputs"]["index"] == 2
    assert graph["52:3"]["inputs"]["seed"] == graph["52:28"]["inputs"]["sampling_mode.seed"] == 42


def test_build_graph_leaves_the_template_untouched():
    server.build_graph(server.GenerationRequest(prompt="x"), 1)
    assert server.WORKFLOW["52:31"]["inputs"]["value"] != "x"


def test_raw_prompt_gets_a_length_tag_once():
    raw = server.GenerationRequest(prompt="door slam.", seconds=2, enhance=False)
    assert server.build_graph(raw, 1)["52:31"]["inputs"]["value"] == "door slam. Length: 2 seconds"
    tagged = server.GenerationRequest(prompt="door slam. Length: 3 seconds", seconds=2, enhance=False)
    assert server.build_graph(tagged, 1)["52:31"]["inputs"]["value"].count("Length:") == 1


# ---------------------------------------------------------------- API

@pytest.mark.parametrize("body, field", [
    ({}, "prompt"),
    ({"prompt": "   "}, "prompt"),
    ({"prompt": "x", "seconds": 999}, "seconds"),
    ({"prompt": "x", "mode": "rap"}, "mode"),
    ({"prompt": "x", "enhance": "yes"}, "enhance"),
    ({"prompt": "x", "seed": -1}, "seed"),
])
def test_invalid_requests_are_rejected(body, field):
    with client(FakeComfy()) as c:
        r = c.post("/api/v1/audio/generations", json=body)
    assert r.status_code == 400
    assert r.json()["detail"].startswith(field)


def test_job_lifecycle():
    fake = FakeComfy()
    with client(fake) as c:
        job = c.post("/api/v1/audio/generations", json={"prompt": "lofi loop", "seconds": 8, "seed": 7}).json()
        assert job["status"] == "queued" and job["seed"] == 7
        done = wait(c, job["id"])
        assert done["status"] == "completed"
        assert done["revised_prompt"] == "an enhanced prompt"
        audio = c.get(f"/api/v1/audio/generations/{job['id']}/content")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    assert audio.content == b"ID3-fake-mp3"
    assert fake.graphs[0]["52:31"]["inputs"]["value"] == "lofi loop"


def test_failed_workflow_is_reported():
    with client(FakeComfy(outcome="error")) as c:
        job = c.post("/api/v1/audio/generations", json={"prompt": "x"}).json()
        done = wait(c, job["id"])
        content = c.get(f"/api/v1/audio/generations/{job['id']}/content")
    assert done["status"] == "failed"
    assert "out of memory" in done["error"]["message"]
    assert content.status_code == 409


def test_queue_is_capped():
    with client(FakeComfy(outcome="pending")) as c:
        codes = [c.post("/api/v1/audio/generations", json={"prompt": "x"}).status_code
                 for _ in range(server.MAX_PENDING + 1)]
    assert codes[:-1] == [200] * server.MAX_PENDING
    assert codes[-1] == 429


def test_unknown_job_is_404():
    with client(FakeComfy()) as c:
        assert c.get("/api/v1/audio/generations/audio_nope").status_code == 404


def test_health_reports_missing_models():
    with client(FakeComfy(models={"checkpoints": []})) as c:
        health = c.get("/api/health").json()
    assert health["comfyui"] is True
    assert "checkpoints/stable_audio_3_medium.safetensors" in health["missing_models"]


def test_health_when_comfyui_is_down():
    def down(request):
        raise httpx.ConnectError("refused")

    app = server.create_app(server.Settings(web_dir=None), transport=httpx.MockTransport(down))
    with TestClient(app) as c:
        assert c.get("/api/health").json() == {"comfyui": False, "missing_models": []}
