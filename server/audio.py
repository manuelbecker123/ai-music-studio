"""Turns raw generator output into game-ready files (Godot).

Profiles:
  oneshot   sound effects: mono, silence trimmed, short fades, peak -1 dBFS          -> WAV
  voice     speech: mono, silence trimmed, short fades, -18 LUFS                     -> WAV
  music     music loop: whole bars cut from the steady middle, seamless, -16 LUFS    -> OGG
  ambience  ambience loop: cut from the middle with a 2 s crossfade, -20 LUFS        -> OGG
  track     music that plays once: silence trimmed, 1 s fade-out, -16 LUFS          -> OGG

Stable Audio composes a whole piece, intro and ending included, so a loop cannot just wrap the
end onto the start: loops are generated longer than asked and cut from the middle.
Loudness uses one linear gain per file, so a seamless loop stays seamless.
"""

from __future__ import annotations

import re
import subprocess

import numpy as np

SR = 44100
PROFILES = {"oneshot": "wav", "voice": "wav", "music": "ogg", "ambience": "ogg", "track": "ogg"}
MAX_GENERATE = 180  # the bridge's limit


def generation_seconds(profile: str, seconds: float) -> float:
    """How much to generate for a clip of `seconds`: loops need room to skip the ending."""
    if profile == "music":
        return min(MAX_GENERATE, seconds / 0.75 + 2)
    if profile == "ambience":
        return min(MAX_GENERATE, seconds + 6)
    return seconds


# ---------------------------------------------------------------- ffmpeg I/O

def decode(data: bytes) -> np.ndarray:
    """Any audio file -> float32 array (2, samples) at 44.1 kHz."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", str(SR), "pipe:1"],
                         input=data, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, 2).T.copy()


def encode(x: np.ndarray, fmt: str) -> bytes:
    codec = {"wav": ["-c:a", "pcm_s16le", "-f", "wav"],
             "ogg": ["-c:a", "libvorbis", "-q:a", "6", "-f", "ogg"],
             "flac": ["-c:a", "flac", "-f", "flac"]}[fmt]
    raw = np.ascontiguousarray(np.clip(x, -1, 1).T, dtype=np.float32).tobytes()
    return subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ac", str(x.shape[0]), "-ar", str(SR),
                           "-i", "pipe:0", *codec, "-map_metadata", "-1", "pipe:1"],
                          input=raw, capture_output=True, check=True).stdout


def loudness(x: np.ndarray) -> float | None:
    """Integrated loudness in LUFS (EBU R128), or None when the clip is too short or silent."""
    r = subprocess.run(["ffmpeg", "-nostats", "-f", "f32le", "-ac", str(x.shape[0]), "-ar", str(SR), "-i", "pipe:0",
                        "-af", "ebur128", "-f", "null", "-"],
                       input=np.ascontiguousarray(x.T, dtype=np.float32).tobytes(), capture_output=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr.decode())
    value = float(m[-1]) if m else None
    return value if value is not None and value > -70 else None


# ---------------------------------------------------------------- processing steps

def db(v: float) -> float:
    return 10 ** (v / 20)


def mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=0, keepdims=True)


def trim_silence(x: np.ndarray, start_db: float = -40, end_db: float = -50) -> np.ndarray:
    env = np.abs(x).max(axis=0)
    peak = env.max()
    if peak == 0:
        return x
    loud = np.nonzero(env > peak * db(start_db))[0]
    tail = np.nonzero(env > peak * db(end_db))[0]
    start = max(0, loud[0] - int(0.005 * SR))
    end = min(x.shape[1], tail[-1] + int(0.05 * SR))
    return x[:, start:end]


def fades(x: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    x = x.copy()
    n_in, n_out = min(int(fade_in * SR), x.shape[1]), min(int(fade_out * SR), x.shape[1])
    if n_in:
        x[:, :n_in] *= np.linspace(0, 1, n_in, dtype=np.float32)
    if n_out:
        x[:, -n_out:] *= np.linspace(1, 0, n_out, dtype=np.float32)
    return x


def peak_normalize(x: np.ndarray, peak_db: float = -1.0) -> np.ndarray:
    peak = np.abs(x).max()
    return x if peak == 0 else x * (db(peak_db) / peak)


def loudness_normalize(x: np.ndarray, target: float, peak_db: float = -1.0) -> np.ndarray:
    """One linear gain towards `target` LUFS, capped so peaks stay at or below `peak_db`."""
    measured = loudness(x)
    peak = np.abs(x).max()
    if measured is None or peak == 0:
        return peak_normalize(x, peak_db)
    gain = min(db(target - measured), db(peak_db) / peak)
    return x * gain


def steady_region(x: np.ndarray, below_db: float = 12) -> tuple[int, int]:
    """(start, end) samples of the part that stays within `below_db` of the typical level,
    which excludes a quiet intro and the fade-out ending."""
    hop = SR // 4
    n = x.shape[1] // hop
    rms = np.sqrt((x[:, :n * hop].reshape(x.shape[0], n, hop) ** 2).mean(axis=(0, 2))) + 1e-9
    level = 20 * np.log10(rms)
    ok = np.nonzero(level > np.percentile(level, 75) - below_db)[0]
    if not len(ok):
        return 0, x.shape[1]
    return ok[0] * hop, (ok[-1] + 1) * hop


def beat_period(x: np.ndarray, bpm_hint: float | None) -> float | None:
    """Beat length in seconds from the onset envelope's autocorrelation. The model's own
    'BPM: n' (from the enhanced prompt) narrows the search when it is available."""
    hop = 512
    m = x.mean(axis=0)
    n = len(m) // hop
    energy = np.sqrt((m[:n * hop].reshape(n, hop) ** 2).mean(axis=1))
    onset = np.maximum(np.diff(energy), 0)
    onset = onset - onset.mean()
    if not onset.any():
        return None
    ac = np.correlate(onset, onset, mode="full")[len(onset) - 1:]
    fps = SR / hop
    lo_bpm, hi_bpm = (bpm_hint * 0.9, bpm_hint * 1.1) if bpm_hint else (70, 170)
    lags = np.arange(int(fps * 60 / hi_bpm), int(fps * 60 / lo_bpm) + 1)
    lags = lags[lags < len(ac)]
    if not len(lags):
        return None
    best = lags[np.argmax(ac[lags])]
    return best / fps


def best_offset(x: np.ndarray, a: int, length: int, search: int, window: int) -> int:
    """Nudges the loop length by up to `search` samples so the audio after the loop end lines
    up best (normalised cross-correlation) with the audio after the loop start."""
    m = x.mean(axis=0)
    ref = m[a:a + window]
    best, best_score = length, -np.inf
    for d in range(-search, search + 1, max(1, search // 200)):
        seg = m[a + length + d:a + length + d + window]
        if len(seg) < window:
            break
        score = float(np.dot(ref, seg) / (np.linalg.norm(ref) * np.linalg.norm(seg) + 1e-9))
        if score > best_score:
            best, best_score = length + d, score
    return best


def cut_loop(x: np.ndarray, seconds: float, beat: float | None, crossfade: float,
             fixed: dict | None = None) -> tuple[np.ndarray, dict]:
    """A seamless loop of about `seconds` from the steady middle of x. With a beat, the length
    is a whole number of bars so the rhythm carries across the seam. `fixed` reuses another
    take's cut (intensity versions), so layers stay in sync. Returns (loop, cut)."""
    if fixed:
        a, length, fade = fixed["start"], fixed["length"], fixed["fade"]
        if a + length + fade > x.shape[1]:
            raise ValueError("the audio is shorter than the loop it must match")
        return crossfade_wrap(x, a, length, fade), fixed
    start, end = steady_region(x)
    a = min(start + int(0.5 * SR), max(0, end - int(seconds * SR)))
    fade = int(crossfade * SR)
    room = end - a - fade
    if beat:
        bar = 4 * beat * SR
        bars = max(1, min(round(seconds * SR / bar), int(room // bar)))
        length = int(round(bars * bar))
        length = best_offset(x, a, length, int(0.02 * SR), int(0.3 * SR))
    else:
        length = min(int(seconds * SR), room)
        length = best_offset(x, a, length, int(0.2 * SR), int(0.5 * SR))
    length = min(length, x.shape[1] - a - fade)
    return crossfade_wrap(x, a, length, fade), {"start": int(a), "length": int(length), "fade": int(fade)}


def crossfade_wrap(x: np.ndarray, a: int, length: int, fade: int) -> np.ndarray:
    y = x[:, a:a + length].copy()
    t = np.linspace(0, 1, fade, dtype=np.float32) * (np.pi / 2)
    # The loop's last sample is followed by x[a + length]; blending that continuation into the
    # start makes the wrap-around sound like the audio simply carrying on.
    y[:, :fade] = x[:, a:a + fade] * np.sin(t) + x[:, a + length:a + length + fade] * np.cos(t)
    return y


# ---------------------------------------------------------------- entry point

# Stable Audio 3's audio-to-audio output leads its reference by exactly 2011 samples at 44.1 kHz
# (45.6 ms; measured with near-copy remixes at several strengths and seeds: always -2011, corr 0.85).
REMIX_LEAD = 2011


def undo_remix_lead(x: np.ndarray) -> np.ndarray:
    """Delays a remix by REMIX_LEAD so it lines up sample-exactly with the audio it came from."""
    return np.concatenate([np.zeros((x.shape[0], REMIX_LEAD), np.float32), x[:, :-REMIX_LEAD]], axis=1)


def edit(finished: bytes, profile: str, start: float, end: float, fade_in: float, fade_out: float) -> tuple[np.ndarray, str]:
    """Trim and fade a finished take (its preview, which is the Godot audio losslessly)."""
    x = decode(finished)
    if PROFILES[profile] == "wav":
        x = mono(x)
    y = fades(x[:, int(start * SR):int(end * SR)], fade_in, fade_out)
    return y.astype(np.float32), PROFILES[profile]


def process(raw: bytes, profile: str, seconds: float | None = None, bpm_hint: float | None = None,
            loop_cut: dict | None = None, remix: bool = False) -> tuple[np.ndarray, str, dict]:
    """-> (processed audio, game file extension, info). `seconds` is the wanted loop length;
    info["loop_cut"] records where a loop was cut, and `loop_cut` reuses such a cut. `remix`
    compensates the audio-to-audio lead so a version stays in time with its original."""
    info: dict = {}
    x = decode(raw)
    if remix:
        x = undo_remix_lead(x)
    if profile == "oneshot":
        y = peak_normalize(fades(trim_silence(mono(x)), 0.002, 0.03))
    elif profile == "voice":
        y = loudness_normalize(fades(trim_silence(mono(x), -35, -45), 0.005, 0.05), -18)
    elif profile == "music":
        beat = None if loop_cut else beat_period(x, bpm_hint)
        loop, info["loop_cut"] = cut_loop(x, seconds, beat, min(0.3, beat / 2) if beat else 0.3, loop_cut)
        y = loudness_normalize(loop, -16)
    elif profile == "ambience":
        loop, info["loop_cut"] = cut_loop(x, seconds, None, 2.0, loop_cut)
        y = loudness_normalize(loop, -20)
    elif profile == "track":
        y = loudness_normalize(fades(trim_silence(x, -60, -60), 0.0, 1.0), -16)
    else:
        raise ValueError(f"unknown profile {profile!r}")
    return y.astype(np.float32), PROFILES[profile], info
