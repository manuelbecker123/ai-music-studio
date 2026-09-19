"""Shared generation presets and validation limits for Music Studio."""

from __future__ import annotations

import re

SFX_CATEGORIES = {
    "footsteps": {"mode": "SFX", "seconds": 2, "loop": False},
    "hit": {"mode": "One-shot", "seconds": 1.5, "loop": False},
    "magic": {"mode": "SFX", "seconds": 3, "loop": False},
    "ui": {"mode": "One-shot", "seconds": 1, "loop": False},
    "creature": {"mode": "SFX", "seconds": 2.5, "loop": False},
    "ambience": {"mode": "SFX", "seconds": 30, "loop": True},
    "other": {"mode": "SFX", "seconds": 3, "loop": False},
}

PRESET_VOICES = {
    "preset_warm_narrator",
    "preset_calm_narrator",
    "preset_storyteller",
    "preset_noble_lady",
    "preset_deep_warrior",
    "preset_old_sage",
    "preset_young_hero",
    "preset_rogue",
}

LANGUAGES = {
    "en", "ar", "da", "de", "el", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms",
    "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}

LANGUAGE_NAMES = {
    "en": "English", "ar": "Arabic", "da": "Danish", "de": "German", "el": "Greek",
    "es": "Spanish", "fi": "Finnish", "fr": "French", "he": "Hebrew", "hi": "Hindi",
    "it": "Italian", "ja": "Japanese", "ko": "Korean", "ms": "Malay", "nl": "Dutch",
    "no": "Norwegian", "pl": "Polish", "pt": "Portuguese", "ru": "Russian", "sv": "Swedish",
    "sw": "Swahili", "tr": "Turkish", "zh": "Chinese",
}

SONG_LANGUAGES = LANGUAGES - {"tr", "zh"}
INTENSITY_PROMPT = "calm, soft and gentle, quiet, sparse arrangement, no drums, ambient pads"

LIMITS = {
    "prompt": 2000,
    "line": 500,
    "lyrics": 3000,
    "sfx_seconds": (0.5, 30),
    "ambience_seconds": (5, 120),
    "music_seconds": (5, 180),
    "loop_seconds": (5, 120),
    "song_seconds": (10, 240),
    "delivery": (0.25, 1.5),
}


def profile_for(kind: str, category: str | None = None, loop: bool = False) -> str:
    if kind == "voice":
        return "voice"
    if kind == "music":
        return "music" if loop else "track"
    return "ambience" if category and SFX_CATEGORIES[category]["loop"] else "oneshot"


def slug(text: str, words: int = 3) -> str:
    """A short file-safe stem made from the description."""
    ignored = {"a", "an", "the", "with", "and", "of", "on", "in", "for"}
    clean = re.sub(r"[^a-z0-9\s]", " ", text.lower()).split()
    return "_".join(word for word in clean if word not in ignored)[:80].strip("_") or "sound"
