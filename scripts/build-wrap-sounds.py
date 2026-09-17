#!/usr/bin/env python3
"""
Prepares the unwrap sounds Lawrence supplied for the web.

  npm run wrap-sounds

Sources (short one-shots, layered by `src/player3d/wrap-sound.ts` across the peel and the sleeve pull):
  peel   ~/Downloads/Medical Unwrap Item Plastic Wrap Peel Adhesive 01.wav  (0.71 s, plastic wrap peeling)
  sleeve ~/Downloads/HumanHand 6106_20_1.wav                                (0.19 s, a hand pulling card)

Writes public/assets/audio/wrap/*.mp3 and src/player3d/wrap-sounds.json. Both are normalised and topped and
tailed, so they can be triggered repeatedly without clicks.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public/assets/audio/wrap"
JSON_OUT = ROOT / "src/player3d/wrap-sounds.json"
SR = 44100
PEAK = 0.89

SOURCES = {
    "peel": Path.home() / "Downloads/Medical Unwrap Item Plastic Wrap Peel Adhesive 01.wav",
    "sleeve": Path.home() / "Downloads/HumanHand 6106_20_1.wav",
}


def read(source: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def trim(samples: np.ndarray, floor: float = 0.004) -> np.ndarray:
    """Drops the silence at each end, then fades 3 ms in and 12 ms out so repeats never click."""
    level = np.abs(samples).max(axis=1)
    loud = np.flatnonzero(level > floor)
    if loud.size:
        samples = samples[max(0, loud[0] - 64) : min(len(samples), loud[-1] + 256)]
    out = samples.copy()
    n_in, n_out = int(0.003 * SR), int(0.012 * SR)
    out[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    out[-n_out:] *= np.linspace(1, 0, n_out)[:, None]
    return out


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
    for name, default in SOURCES.items():
        parser.add_argument(f"--{name}", default=str(default))
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {}
    for name in SOURCES:
        audio = trim(read(Path(getattr(args, name)).expanduser()))
        audio = audio * (PEAK / max(1e-6, float(np.abs(audio).max())))
        size = encode(audio, f"{name}.mp3")
        manifest[name] = {"url": f"/assets/audio/wrap/{name}.mp3", "duration": round(len(audio) / SR, 3)}
        print(f"  {name}.mp3 {size / 1024:5.0f} KB  {manifest[name]['duration']} s")

    JSON_OUT.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
