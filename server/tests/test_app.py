import copy
import asyncio
import time

from fastapi.testclient import TestClient

import app as server


class FakeEngine:
    def __init__(self):
        self.rendered = []
        self.voices = {}

    async def online(self):
        return True

    async def render(self, take, parent, store):
        self.rendered.append((copy.deepcopy(take), copy.deepcopy(parent)))
        extension = "ogg" if take["profile"] in ("music", "ambience", "track") else "wav"
        return server.Rendered(
            preview=b"fake-flac",
            game=b"fake-game",
            game_ext=extension,
            duration=take["seconds"] or 1.25,
            revised_prompt=f"Detailed {take['prompt']}",
            source=None if take["kind"] == "voice" else b"fake-source",
            loop_cut={"start": 10, "length": 100, "fade": 5}
            if take["profile"] in ("music", "ambience")
            else None,
        )

    async def prepare_voice(self, voice_id, data, suffix):
        self.voices[voice_id] = data

    async def delete_voice(self, voice_id):
        self.voices.pop(voice_id, None)


def client(tmp_path):
    engine = FakeEngine()
    settings = server.Settings(data_dir=tmp_path, web_dir=None)
    return TestClient(server.create_app(settings, engine)), engine


def wait(client, take_id):
    for _ in range(200):
        take = client.get(f"/api/takes/{take_id}").json()
        if take["status"] in ("completed", "failed"):
            return take
        time.sleep(0.005)
    raise AssertionError("take did not finish")


def create_and_wait(client, body):
    created = client.post("/api/takes", json=body)
    assert created.status_code == 200, created.text
    takes = created.json()["takes"]
    return [wait(client, take["id"]) for take in takes]


def test_sound_effect_versions_are_grouped_and_game_ready(tmp_path):
    with client(tmp_path)[0] as api:
        takes = create_and_wait(api, {
            "kind": "sfx",
            "category": "footsteps",
            "prompt": "Heavy boots on wet gravel",
            "versions": 4,
            "seed": 20,
        })
        assert len(takes) == 4
        assert {take["group_id"] for take in takes} == {takes[0]["group_id"]}
        assert [take["seed"] for take in takes] == [20, 21, 22, 23]
        assert all(take["game_ext"] == "wav" for take in takes)
        preview = api.get(f"/api/takes/{takes[0]['id']}/preview")
        game = api.get(f"/api/takes/{takes[0]['id']}/file")
    assert preview.content == b"fake-flac"
    assert game.content == b"fake-game"
    assert 'filename="sfx_footsteps_01.wav"' in game.headers["content-disposition"]


def test_music_loop_can_be_saved_renamed_and_made_calm(tmp_path):
    api, _ = client(tmp_path)
    with api:
        take = create_and_wait(api, {
            "kind": "music", "prompt": "Dark forest at 90 BPM",
            "seconds": 30, "loop": True,
        })[0]
        assert take["profile"] == "music"
        assert take["game_ext"] == "ogg"
        changed = api.patch(
            f"/api/takes/{take['id']}",
            json={"name": "forest exploration", "saved": True},
        ).json()
        assert changed["name"] == "forest_exploration"
        assert api.get("/api/library").json()["takes"][0]["id"] == take["id"]
        calm = create_and_wait(
            api, {"parent_id": take["id"], "intensity": True}
        )[0]
    assert calm["intensity"] == "Calm"
    assert calm["parent_id"] == take["id"]


def test_songs_keep_lyrics_and_voice_translation_choice(tmp_path):
    api, engine = client(tmp_path)
    with api:
        song = create_and_wait(api, {
            "kind": "music", "vocals": True, "prompt": "Cheerful folk song",
            "lyrics": "[verse]\nHello", "seconds": 60, "language": "en",
        })[0]
        voice = create_and_wait(api, {
            "kind": "voice", "prompt": "The bridge is out.",
            "voice_id": "preset_warm_narrator", "delivery": 0.8,
            "language": "en", "translate_to": "fr",
        })[0]
    assert song["song"] is True
    assert song["lyrics"] == "[verse]\nHello"
    assert voice["translate_to"] == "fr"
    assert voice["language"] == "fr"
    assert engine.rendered[-1][0]["voice_id"] == "preset_warm_narrator"


def test_refine_and_trim_inherit_the_original(tmp_path):
    api, engine = client(tmp_path)
    with api:
        original = create_and_wait(api, {
            "kind": "sfx", "category": "hit", "prompt": "Sword on shield",
            "versions": 1,
        })[0]
        refined = create_and_wait(api, {
            "parent_id": original["id"], "difference": 0.7,
            "direction": "more metallic",
        })[0]
        trimmed = create_and_wait(api, {
            "parent_id": original["id"],
            "edit": {"start": 0, "end": 1, "fade_in": 0.05, "fade_out": 0.1},
        })[0]
    assert refined["parent_id"] == original["id"]
    assert "more metallic" in refined["prompt"]
    assert trimmed["edited"] is True
    assert engine.rendered[-1][1]["id"] == original["id"]


def test_recorded_voices_can_be_replaced_and_deleted(tmp_path):
    api, engine = client(tmp_path)
    with api:
        first = api.post(
            "/api/voices",
            data={"name": "Narrator"},
            files={"audio": ("voice.wav", b"one", "audio/wav")},
        )
        assert first.status_code == 200
        second = api.post(
            "/api/voices",
            data={"name": "Narrator"},
            files={"audio": ("voice.wav", b"two", "audio/wav")},
        )
        voices = api.get("/api/voices").json()["voices"]
        assert len(voices) == 1
        voice_id = second.json()["id"]
        assert api.delete(f"/api/voices/{voice_id}").json() == {"ok": True}
    assert engine.voices == {}


def test_delete_removes_metadata_and_files(tmp_path):
    api, _ = client(tmp_path)
    with api:
        take = create_and_wait(api, {
            "kind": "sfx", "category": "ui", "prompt": "Soft click",
            "versions": 1,
        })[0]
        assert api.delete(f"/api/takes/{take['id']}").status_code == 200
        assert api.get(f"/api/takes/{take['id']}").status_code == 404
    assert not (tmp_path / "takes" / take["id"]).exists()


def test_invalid_requests_are_rejected(tmp_path):
    api, _ = client(tmp_path)
    with api:
        assert api.post("/api/takes", json={}).status_code == 400
        assert api.post("/api/takes", json={
            "kind": "sfx", "category": "unknown", "prompt": "x", "versions": 1,
        }).status_code == 400
        assert api.post("/api/takes", json={
            "kind": "music", "prompt": "x", "seconds": 999, "loop": True,
        }).status_code == 400
        assert api.post("/api/takes", json={
            "kind": "voice", "prompt": "x", "language": "klingon",
        }).status_code == 400


def test_audio_generation_lengths_leave_room_for_loop_cutting():
    assert server.audio.generation_seconds("oneshot", 10) == 10
    assert server.audio.generation_seconds("ambience", 30) == 36
    assert server.audio.generation_seconds("music", 30) == 42


class CapturingModels(server.LocalModels):
    def __init__(self, settings):
        super().__init__(settings)
        self.graph = None

    async def _run(self, graph, output_node, text_node=None):
        self.graph = graph
        return b"audio", "expanded prompt"

    async def _upload(self, data, prefix):
        return "uploaded-reference.flac"


def test_stable_audio_workflow_maps_prompt_mode_and_both_seeds(tmp_path):
    models = CapturingModels(server.Settings(data_dir=tmp_path, web_dir=None))
    take = {
        "prompt": "wooden click", "enhance": True, "mode": "One-shot",
        "seed": 9, "prompt_seed": 7, "strength": None,
    }
    audio_bytes, revised = asyncio.run(models._stable(take, 1.5, None))
    graph = models.graph
    assert audio_bytes == b"audio" and revised == "expanded prompt"
    assert graph["52:31"]["inputs"]["value"] == "wooden click"
    assert graph["52:36"]["inputs"]["value"] == 1.5
    assert graph["52:43"]["inputs"]["choice"] == "One-shot"
    assert graph["52:43"]["inputs"]["index"] == 3
    assert graph["52:3"]["inputs"]["seed"] == 9
    assert graph["52:28"]["inputs"]["sampling_mode.seed"] == 7


def test_reference_audio_selects_the_remix_workflow(tmp_path):
    models = CapturingModels(server.Settings(data_dir=tmp_path, web_dir=None))
    take = {
        "prompt": "calmer", "enhance": False, "mode": "Music",
        "seed": 3, "prompt_seed": 3, "strength": 0.8,
    }
    asyncio.run(models._stable(take, 30, b"reference"))
    assert models.graph["92"]["inputs"]["audio"] == "uploaded-reference.flac"
    assert models.graph["52:3"]["inputs"]["denoise"] == 0.8


def test_song_workflow_maps_lyrics_language_and_duration(tmp_path):
    models = CapturingModels(server.Settings(data_dir=tmp_path, web_dir=None))
    take = {
        "prompt": "folk song in D minor, 84 BPM", "seconds": 60,
        "seed": 11, "language": "en", "strength": None,
        "options": {"engine": "song", "lyrics": "[verse]\nSail away"},
    }
    asyncio.run(models._song(take, None))
    graph = models.graph
    assert graph["94"]["inputs"]["tags"] == take["prompt"]
    assert graph["94"]["inputs"]["lyrics"] == "[verse]\nSail away"
    assert graph["94"]["inputs"]["language"] == "en"
    assert graph["94"]["inputs"]["duration"] == 60
    assert graph["94"]["inputs"]["bpm"] == 84
    assert graph["94"]["inputs"]["keyscale"] == "D minor"
    assert graph["109"]["inputs"]["value"] == 11
