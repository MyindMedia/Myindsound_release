#!/usr/bin/env python3
"""
Cuts the drive recording into the disc mechanics sounds and the RPM curves the animation follows.

  npm run disc-sounds
  npm run disc-sounds -- --source /path/to/CD_Drive_06_11.wav

Source: ~/Downloads/CD_Drive_06_11.wav (13.4 s, 44.1 kHz stereo). Markers were set from its loudness and
spectral envelope (Lawrence's guide: 0-3 s load and spin up, 4-10 s spinning, 11-13 s stop):
  spin-up   0.00-3.80  loading clunks to 1.7 s (loudest at 0.9 s: the clamp), motor whine from 2.55 s, full at 3.8 s
  loop      3.80-9.80  steady spin with drive clicks; crossfaded so the seam is silent
  spin-down 10.60-13.39 steady until the brake click at 11.6 s, then the decay to silence
  unload    0.00-1.45  the load sound again, played forward before the eject: the first clunks (0.08/0.16 s) are
                       the hub unclamping, the sled travels, and the big clunk at 0.96 s pops the cartridge; it
                       ends in the silence before 1.5 s

Writes public/assets/audio/disc/*.mp3 and src/player3d/disc-sounds.json. The loop file carries guard bands
(the loop's own continuation) around the loop points, so decoder padding never lands on a seam.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public/assets/audio/disc"
JSON_OUT = ROOT / "src/player3d/disc-sounds.json"
SR = 44100

SPIN_UP = (0.0, 3.8)
LOOP = (3.8, 9.8)
LOOP_CROSSFADE = 0.25
LOOP_GUARD = 0.3
SPIN_DOWN = (10.6, 13.3936)
LOAD = (0.0, 1.45)
# Hits in the load that the eject follows: the spindle drops on the first clunk, the cartridge pops on the loudest.
UNLOAD_UNCLAMP = 0.16
UNLOAD_RELEASE = 0.96

# Disc speed (fraction of play speed) against time into each sound, read off the envelopes.
SPIN_UP_RPM = [[0, 0], [2.55, 0], [2.8, 0.3], [3.1, 0.55], [3.4, 0.78], [3.7, 0.95], [3.8, 1]]
SPIN_DOWN_RPM = [[0, 1], [1.0, 1], [1.2, 0.9], [1.4, 0.66], [1.6, 0.42], [1.8, 0.29], [2.0, 0.2], [2.4, 0.1], [2.79, 0]]
# When the spindle should meet the hub (the clamp clunk).
CLAMP_AT = 0.85


def read(source: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def fade(samples: np.ndarray, seconds_in: float, seconds_out: float) -> np.ndarray:
    out = samples.copy()
    n_in, n_out = int(seconds_in * SR), int(seconds_out * SR)
    if n_in:
        out[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    if n_out:
        out[-n_out:] *= np.linspace(1, 0, n_out)[:, None]
    return out


def seamless_loop(audio: np.ndarray) -> np.ndarray:
    """Loop of LOOP length whose end flows into its start: the head is crossfaded with what followed the end."""
    start, n, x = int(LOOP[0] * SR), int((LOOP[1] - LOOP[0]) * SR), int(LOOP_CROSSFADE * SR)
    source = audio[start : start + n + x]
    loop = source[:n].copy()
    t = np.sqrt(np.linspace(0, 1, x))[:, None]  # equal-power
    loop[:x] = source[:x] * t + source[n : n + x] * np.sqrt(1 - t**2)
    return loop


def encode(samples: np.ndarray, name: str) -> int:
    path = OUT_DIR / name
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-",
         "-map_metadata", "-1", "-b:a", "192k", str(path)],
        input=np.clip(samples, -1, 1).astype(np.float32).tobytes(), check=True,
    )
    return path.stat().st_size


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(Path.home() / "Downloads/CD_Drive_06_11.wav"))
    args = parser.parse_args()
    audio = read(Path(args.source).expanduser())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cut = lambda span: audio[int(span[0] * SR) : int(span[1] * SR)]

    spin_up = fade(cut(SPIN_UP), 0.005, 0.0)
    loop = seamless_loop(audio)
    guard = int(LOOP_GUARD * SR)
    looped = np.concatenate([loop[-guard:], loop, loop[:guard]])
    spin_down = fade(cut(SPIN_DOWN), 0.0, 0.08)
    unload = fade(cut(LOAD), 0.005, 0.01)

    sizes = {
        "disc-spin-up.mp3": encode(spin_up, "disc-spin-up.mp3"),
        "disc-spin-loop.mp3": encode(looped, "disc-spin-loop.mp3"),
        "disc-spin-down.mp3": encode(spin_down, "disc-spin-down.mp3"),
        "disc-unload.mp3": encode(unload, "disc-unload.mp3"),
    }
    manifest = {
        "source": Path(args.source).name,
        "spinUp": {
            "url": "/assets/audio/disc/disc-spin-up.mp3",
            "duration": round(len(spin_up) / SR, 3),
            "clampAt": CLAMP_AT,
            "rpm": SPIN_UP_RPM,
        },
        "loop": {
            "url": "/assets/audio/disc/disc-spin-loop.mp3",
            "guard": LOOP_GUARD,
            "length": round(len(loop) / SR, 4),
        },
        "spinDown": {
            "url": "/assets/audio/disc/disc-spin-down.mp3",
            "duration": round(len(spin_down) / SR, 3),
            "rpm": SPIN_DOWN_RPM,
        },
        "unload": {
            "url": "/assets/audio/disc/disc-unload.mp3",
            "duration": round(len(unload) / SR, 3),
            "unclampAt": UNLOAD_UNCLAMP,
            "releaseAt": UNLOAD_RELEASE,
        },
    }
    JSON_OUT.write_text(json.dumps(manifest, indent=1) + "\n")
    for name, size in sizes.items():
        print(f"  {name:22s} {size / 1024:5.0f} KB")
    print(f"  spin-up {manifest['spinUp']['duration']} s, loop {manifest['loop']['length']} s, spin-down {manifest['spinDown']['duration']} s, unload {manifest['unload']['duration']} s")


if __name__ == "__main__":
    main()
