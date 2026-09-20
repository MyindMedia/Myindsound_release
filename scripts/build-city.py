#!/usr/bin/env python3
"""
The city the player is set in, and the two maps the backdrop shader reads with it.

  npm run city                                  # uses the painting below
  npm run city -- --source "~/Downloads/Wide BG.png"

Writes public/assets/images/minidisc/:
  city-comic.webp   the painting, fitted to 21:9 so there is room to parallax into
  city-depth.webp   red channel: white is near, black is far. The shader shifts near and far apart, and
                    treats anything under 0.16-0.3 as sky the flying craft pass through
  city-mask.webp    red: the neon that pulses. green: the beam that shimmers. blue: the drawn lines,
                    inked off the painting's own edges and laid back over it in the shader

The maps used to come from an image model. They are derived from the painting itself now, so a new
backdrop is one command rather than three round trips: the neon is found by how saturated and bright a
pixel is, the beam by the bright desaturated column, and the depth from the shape of a street shot
(the frame's edges and its floor are near, the vanishing point and the sky are far), softened so the
parallax slides rather than tears.
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public/assets/images/minidisc"
DEFAULT_SOURCE = "~/Downloads/New BG.png"
WIDE = (3360, 1440)   # 21:9, the plane the backdrop is drawn on
# The depth is sampled smoothly and could be tiny, but the mask carries the inked linework in its blue
# channel, and a pen stroke is the one thing in here that shows its resolution. Sized for the lines.
MAPS = (2240, 960)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def fit_wide(source: Image.Image) -> Image.Image:
    """
    The painting is 16:9 and the plane is 21:9. Rather than stretch it, it is placed at full height and
    the peripheral strips are smeared out from its own edges and darkened: that area sits outside the
    frame at most window shapes, and reads as depth haze when a wide one brings it into view.
    """
    width, height = WIDE
    scaled_w = round(source.width * height / source.height)
    art = source.resize((scaled_w, height), Image.LANCZOS)
    canvas = Image.new("RGB", (width, height))
    left = (width - scaled_w) // 2
    canvas.paste(art, (left, 0))

    gap = left
    if gap > 0:
        strip = max(8, round(scaled_w * 0.02))
        for side in ("left", "right"):
            edge = art.crop((0, 0, strip, height)) if side == "left" else art.crop((scaled_w - strip, 0, scaled_w, height))
            smear = edge.resize((gap, height), Image.LANCZOS).filter(ImageFilter.GaussianBlur(gap * 0.06))
            # Fade it down as it goes out, so the join disappears into the dark.
            fade = np.linspace(0.0, 1.0, gap, dtype=np.float32)
            if side == "left":
                fade = fade * 0.55 + 0.1
            else:
                fade = fade[::-1] * 0.55 + 0.1
            pixels = np.asarray(smear, dtype=np.float32) * fade[None, :, None]
            smear = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))
            canvas.paste(smear, (0 if side == "left" else left + scaled_w, 0))
    return canvas


def set_back(image: Image.Image, dim: float) -> Image.Image:
    """
    The painting is a backdrop, not the subject: it is taken down a stop and shaded towards its edges, so
    the deck reads against it and the beam behind the cartridge stops blowing out.
    """
    pixels = np.asarray(image, dtype=np.float32) / 255.0
    height, width = pixels.shape[:2]
    u = np.linspace(-1.0, 1.0, width, dtype=np.float32)[None, :]
    v = np.linspace(-1.0, 1.0, height, dtype=np.float32)[:, None]
    vignette = 1.0 - 0.32 * np.clip((u * u) * 0.8 + (v * v) * 0.5, 0.0, 1.0)
    shaded = np.clip(pixels * dim * vignette[..., None], 0.0, 1.0)
    return Image.fromarray((shaded * 255).astype(np.uint8))


def channels(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Brightness and saturation, 0 to 1."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    value = rgb.max(axis=2)
    saturation = np.where(value > 0, (value - rgb.min(axis=2)) / np.maximum(value, 1e-6), 0.0)
    return value, saturation


def build_depth(image: Image.Image) -> Image.Image:
    """White near, black far: the frame's edges and its floor come forward, the vanishing point goes back."""
    width, height = MAPS
    small = image.resize((width, height), Image.LANCZOS)
    value, _ = channels(small)

    u = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    v = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    to_side = smoothstep(0.34, 1.0, np.abs(u - 0.5) * 2)   # buildings at the edges of the shot
    to_floor = smoothstep(0.58, 1.0, v) * 0.92             # wet street under the camera
    depth = np.maximum(to_side, to_floor)
    # Lit faces at the edges sit a little nearer than the dark gaps between them.
    depth = np.clip(depth + 0.16 * value * to_side, 0.0, 1.0)

    out = Image.fromarray((depth * 255).astype(np.uint8), mode="L")
    return out.filter(ImageFilter.GaussianBlur(width * 0.012))


def grey(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0.0, 1.0) * 255).astype(np.uint8), mode="L")


def blurred(a: np.ndarray, sigma: float) -> Image.Image:
    return grey(a).filter(ImageFilter.GaussianBlur(sigma))


def soften(a: np.ndarray, sigma: float) -> np.ndarray:
    return np.asarray(blurred(a, sigma), dtype=np.float32) / 255.0


def build_ink(value: np.ndarray, saturation: np.ndarray) -> np.ndarray:
    """
    The drawn lines. A difference of Gaussians over the painting's tone, which is what an inker does by
    hand: follow where the light changes fastest and lay the stroke down the dark side of it. A gradient
    term goes in alongside it so a flat silhouette against the sky still gets an edge, and the blown-out
    middle of the shot is left clean, because nobody inks fog.
    """
    smooth = soften(value, 1.1)                       # photographic grain is not linework
    edge_of = soften(smooth, 1.0) - soften(smooth, 2.6)
    line = smoothstep(0.0015, 0.022, -edge_of)        # the dark side of the edge takes the stroke

    gx = np.zeros_like(smooth)
    gy = np.zeros_like(smooth)
    gx[:, 1:-1] = smooth[:, 2:] - smooth[:, :-2]
    gy[1:-1, :] = smooth[2:, :] - smooth[:-2, :]
    silhouette = smoothstep(0.018, 0.11, np.sqrt(gx * gx + gy * gy))

    ink = np.clip(line * 0.95 + silhouette * 0.85, 0.0, 1.0)
    # A stroke thinner than a pixel disappears the moment the plane is scaled, so each one is spread to
    # its neighbours: the pen has a nib, it is not a sampling of where an edge was.
    nib = ink.copy()
    nib[:, 1:] = np.maximum(nib[:, 1:], ink[:, :-1])
    nib[1:, :] = np.maximum(nib[1:, :], ink[:-1, :])
    ink = np.maximum(ink, nib * 0.85)
    # Anything bright and colourless is haze or the beam: a pen stroke across it reads as dirt.
    return ink * (1.0 - smoothstep(0.55, 0.92, smooth) * (1.0 - smoothstep(0.25, 0.6, saturation)))


def build_mask(image: Image.Image) -> Image.Image:
    """Red: the neon that pulses. Green: the beam that shimmers. Blue: the drawn lines."""
    width, height = MAPS
    small = image.resize((width, height), Image.LANCZOS)
    value, saturation = channels(small)

    neon = smoothstep(0.32, 0.78, saturation) * smoothstep(0.22, 0.62, value)

    # The beam is the brightest, least coloured column in the upper half of the shot.
    lit = smoothstep(0.62, 0.95, value) * (1.0 - smoothstep(0.1, 0.4, saturation))
    columns = lit[: height // 2].mean(axis=0)
    window = max(9, round(width * 0.01))
    centre = float(np.argmax(np.convolve(columns, np.ones(window) / window, mode="same"))) / width
    u = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    v = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    column = np.exp(-(((u - centre) / 0.035) ** 2))
    beam = np.clip(lit * column * (1.0 - smoothstep(0.62, 1.0, v)), 0.0, 1.0)

    # Neon and beam are read as soft fields and are blurred to match. The ink is not: blur a line enough
    # and it stops being a line.
    return Image.merge("RGB", (blurred(neon, 1.6), blurred(beam, 1.6), blurred(build_ink(value, saturation), 0.4)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--dim", type=float, default=0.6, help="How far the backdrop sits behind the deck")
    args = parser.parse_args()
    source_path = Path(args.source).expanduser()
    if not source_path.exists():
        raise SystemExit(f"Backdrop not found: {source_path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source = Image.open(source_path).convert("RGB")
    wide = fit_wide(source)
    # The maps are read off the full-strength painting; only what is drawn is taken down.
    set_back(wide, args.dim).save(OUT_DIR / "city-comic.webp", quality=90, method=6)
    build_depth(wide).convert("RGB").save(OUT_DIR / "city-depth.webp", quality=82, method=6)
    # The mask carries the linework, and webp softens a thin dark stroke long before it softens a field.
    build_mask(wide).save(OUT_DIR / "city-mask.webp", quality=94, method=6)

    for name in ("city-comic.webp", "city-depth.webp", "city-mask.webp"):
        path = OUT_DIR / name
        print(f"  {name:20s} {path.stat().st_size / 1024:6.0f} KB")


if __name__ == "__main__":
    main()
