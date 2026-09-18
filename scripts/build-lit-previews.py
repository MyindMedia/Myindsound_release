#!/usr/bin/env python3
"""
Cuts a 30-second preview of each LIT track for the public stream page (no sign-in).
The full songs stay paid (Convex storage); only these previews are public.

  npm run previews
  npm run previews -- --source "/path/to/LIT folder"

Reads scripts/lit-tracks.json: titles, files, an optional per-track "previewStart" in seconds (default:
25% in) and "gainDb", the album levelling correction. Each preview is then levelled on its own to
"previewLufs", because they are heard one after another with nothing else to judge them against, so they
have to match; the gain is capped to keep a true peak of -1 dBTP.
Writes public/assets/audio/lit-previews/*.mp3 (128 kbps, faded, tags stripped) and src/player3d/lit-previews.json.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts/lit-tracks.json"
OUT_DIR = ROOT / "public/assets/audio/lit-previews"
PREVIEWS_JSON = ROOT / "src/player3d/lit-previews.json"
LENGTH = 30.0
TRUE_PEAK_CEILING = -1.0


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def loudness(path: Path) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP), from ffmpeg's EBU R128 analysis."""
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    report = json.loads(out.stderr[out.stderr.rindex("{"): out.stderr.rindex("}") + 1])
    return float(report["input_i"]), float(report["input_tp"])


def main():
    manifest = json.loads(MANIFEST.read_text())
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(Path(manifest["defaultSourceDir"]).expanduser()))
    args = parser.parse_args()
    source = Path(args.source).expanduser()
    if not source.exists():
        sys.exit(f"LIT source folder not found: {source}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = float(manifest.get("previewLufs", -14.0))

    tracks = []
    for track in manifest["tracks"]:
        src = source / track["file"]
        full = duration(src)
        start = float(track.get("previewStart", round(full * 0.25, 1)))
        start = max(0.0, min(start, full - LENGTH))
        album_gain = float(track.get("gainDb", 0.0))
        name = f'{track["name"]}.mp3'
        out = OUT_DIR / name
        fades = f"afade=t=in:d=0.8,afade=t=out:st={LENGTH - 2}:d=2"
        cut_filter = f"volume={album_gain}dB,{fades}" if album_gain else fades

        with tempfile.TemporaryDirectory() as workspace:
            # Cut first, uncompressed, so the levelling gain and the MP3 encode happen in one pass.
            cut = Path(workspace) / "cut.wav"
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-y", "-ss", f"{start}", "-t", f"{LENGTH}", "-i", str(src),
                    "-map", "0:a", "-map_metadata", "-1", "-af", cut_filter,
                    "-ac", "2", "-ar", "44100", str(cut),
                ],
                check=True,
            )
            measured, peak = loudness(cut)
            level = min(target - measured, TRUE_PEAK_CEILING - peak)
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-y", "-i", str(cut),
                    "-map", "0:a", "-map_metadata", "-1", "-af", f"volume={level:.2f}dB",
                    "-ac", "2", "-ar", "44100", "-b:a", "128k", str(out),
                ],
                check=True,
            )

        final_loudness, final_peak = loudness(out)
        tracks.append({
            "position": track["position"],
            "title": track["title"],
            "streamUrl": f"/assets/audio/lit-previews/{name}",
            "durationSeconds": round(duration(out), 2),
            "previewStart": start,
        })
        print(
            f"  {track['position']:02d} {track['title']:28s} from {start:6.1f}s  "
            f"{level:+5.2f} dB  {final_loudness:6.2f} LUFS  {final_peak:5.2f} dBTP  {out.stat().st_size / 1024:5.0f} KB"
        )

    PREVIEWS_JSON.write_text(json.dumps({"lengthSeconds": LENGTH, "tracks": tracks}, indent=1) + "\n")
    print(f"  wrote {PREVIEWS_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
