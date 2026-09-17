#!/usr/bin/env python3
"""
Cuts a 30-second preview of each LIT track for the public demo stream page (no sign-in).
The full songs stay paid (Convex + R2); only these previews are public.

  npm run previews
  npm run previews -- --source "/path/to/LIT folder"

Reads scripts/lit-tracks.json (titles, files, optional per-track "previewStart" in seconds; default: 25% in).
Writes public/assets/audio/lit-previews/*.mp3 (128 kbps, faded, tags stripped) and src/player3d/lit-previews.json.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts/lit-tracks.json"
OUT_DIR = ROOT / "public/assets/audio/lit-previews"
PREVIEWS_JSON = ROOT / "src/player3d/lit-previews.json"
LENGTH = 30.0


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def main():
    manifest = json.loads(MANIFEST.read_text())
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(Path(manifest["defaultSourceDir"]).expanduser()))
    args = parser.parse_args()
    source = Path(args.source).expanduser()
    if not source.exists():
        sys.exit(f"LIT source folder not found: {source}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tracks = []
    for track in manifest["tracks"]:
        src = source / track["file"]
        full = duration(src)
        start = float(track.get("previewStart", round(full * 0.25, 1)))
        start = max(0.0, min(start, full - LENGTH))
        name = Path(track["streamKey"]).name
        out = OUT_DIR / name
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-ss", f"{start}", "-t", f"{LENGTH}", "-i", str(src),
                "-map", "0:a", "-map_metadata", "-1",
                "-af", f"afade=t=in:d=0.8,afade=t=out:st={LENGTH - 2}:d=2",
                "-ac", "2", "-ar", "44100", "-b:a", "128k", str(out),
            ],
            check=True,
        )
        tracks.append({
            "position": track["position"],
            "title": track["title"],
            "streamUrl": f"/assets/audio/lit-previews/{name}",
            "durationSeconds": round(duration(out), 2),
            "previewStart": start,
        })
        print(f"  {track['position']:02d} {track['title']:28s} from {start:6.1f}s  {out.stat().st_size / 1024:5.0f} KB")

    PREVIEWS_JSON.write_text(json.dumps({"lengthSeconds": LENGTH, "tracks": tracks}, indent=1) + "\n")
    print(f"  wrote {PREVIEWS_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
