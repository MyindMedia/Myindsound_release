#!/usr/bin/env python3
"""
Builds the 3D MiniDisc player textures and geometry from the Canva export.

  npm run textures
  npm run textures -- --source "/path/to/transparent"

Source: Canva design DAHAUDNdp9k ("CD PLYAER MYINDSOUND"), exported as transparent PNGs
(Canva MCP export-design, png, transparent_background: true) to
~/Downloads/CD PLYAER MYINDSOUND/transparent/{1..18}.png.

Pages 11-18 share one 3756x3827 canvas. Pages 7-10 share a 1600x1362 canvas at about 1/3 scale;
REG_* below registers them onto the large canvas (checked against the page 11 composite).
Outputs WebP textures to public/assets/images/minidisc/ and src/player3d/geometry.json.
World units: body width = 1.0, origin at the body centre, +y up.
"""
import argparse
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public/assets/images/minidisc"
GEOMETRY_OUT = ROOT / "src/player3d/geometry.json"
BUDGET_BYTES = 4 * 1024 * 1024
QUALITY = 86

# Body (page 13) bounding box on the large canvas.
BODY = (484, 0, 3276, 3124)
# Pages 7-10 -> large canvas: X = x * SX + OX, Y = y * SY + OY
SX, SY = 2793 / 928, 3125 / 1031
OX, OY = 484 - 334 * SX, 0 - 36 * SY
# Key columns on page 11 (x ranges), measured from the dark seams between keys.
KEYS = [
    ("pause", 532, 962),
    ("stop", 962, 1390),
    ("prev", 1390, 1818),
    ("next", 1818, 2247),
    ("play", 2247, 2664),
    ("red", 2669, 3226),
]
KEY_TOP = 3040
# "Do Not Duplicate" label on pages 12/14, measured from page 14's opaque pixels.
DND_LABEL = (1490, 218, 2339, 691)  # a little under the body's bottom edge, so a pressed key never shows a gap

body_w = BODY[2] - BODY[0]
cx, cy = (BODY[0] + BODY[2]) / 2, (BODY[1] + BODY[3]) / 2


def to_world(x, y):
    return [round((x - cx) / body_w, 5), round((cy - y) / body_w, 5)]


def rect_world(x0, y0, x1, y1):
    (wx0, wy1), (wx1, wy0) = to_world(x0, y0), to_world(x1, y1)
    return {"x0": wx0, "y0": wy0, "x1": wx1, "y1": wy1}


def alpha_bbox(img, threshold=20):
    a = np.array(img.getchannel("A"))
    ys, xs = np.where(a > threshold)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def save_webp(img, name, max_side):
    scale = min(1.0, max_side / max(img.width, img.height))
    if scale < 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    path = OUT_DIR / name
    img.save(path, "WEBP", quality=QUALITY, method=6, exact=False)
    return path.stat().st_size, img.size


def trace_boundary(mask):
    """Moore-neighbour tracing of the outer boundary of the True region in `mask`."""
    ys, xs = np.nonzero(mask)
    start_idx = np.lexsort((xs, ys))[0]
    start = (int(ys[start_idx]), int(xs[start_idx]))
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    h, w = mask.shape

    def inside(p):
        return 0 <= p[0] < h and 0 <= p[1] < w and mask[p]

    boundary = [start]
    current, backtrack_dir = start, 6  # came from the west
    for _ in range(mask.size):
        found = False
        for step in range(8):
            d = (backtrack_dir + 1 + step) % 8
            nxt = (current[0] + dirs[d][0], current[1] + dirs[d][1])
            if inside(nxt):
                backtrack_dir = (d + 4) % 8
                current = nxt
                found = True
                break
        if not found or current == start:
            break
        boundary.append(current)
    return boundary


def rdp(points, epsilon):
    """Ramer-Douglas-Peucker, iterative (no recursion limit on long boundaries)."""
    if len(points) < 3:
        return list(points)
    pts = np.asarray(points, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        line = pts[last] - pts[first]
        norm = np.hypot(line[0], line[1]) or 1.0
        rel = pts[first + 1 : last] - pts[first]
        dists = np.abs(line[0] * rel[:, 1] - line[1] * rel[:, 0]) / norm
        index = int(np.argmax(dists))
        if dists[index] > epsilon:
            split = first + 1 + index
            keep[split] = True
            stack.append((first, split))
            stack.append((split, last))
    return [tuple(p) for p in pts[keep].astype(int).tolist()]


def simplify_closed(points, max_points):
    epsilon = 0.5
    simplified = points
    while True:
        half = len(points) // 2
        simplified = rdp(points[: half + 1], epsilon)[:-1] + rdp(points[half:] + [points[0]], epsilon)[:-1]
        if len(simplified) <= max_points:
            return simplified
        epsilon *= 1.5


def largest_hole(mask):
    """Transparent regions not connected to the image border; returns the largest as a mask."""
    h, w = mask.shape
    exterior = np.zeros_like(mask, dtype=bool)
    queue = deque()
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and not mask[ny, nx] and not exterior[ny, nx]:
                exterior[ny, nx] = True
                queue.append((ny, nx))
    holes = ~mask & ~exterior
    labels = np.zeros(mask.shape, dtype=np.int32)
    best, best_size, current = None, 0, 0
    for y, x in zip(*np.nonzero(holes)):
        if labels[y, x]:
            continue
        current += 1
        size = 0
        queue = deque([(y, x)])
        labels[y, x] = current
        while queue:
            py, px = queue.popleft()
            size += 1
            for ny, nx in ((py + 1, px), (py - 1, px), (py, px + 1), (py, px - 1)):
                if 0 <= ny < h and 0 <= nx < w and holes[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = current
                    queue.append((ny, nx))
        if size > best_size:
            best, best_size = current, size
    return labels == best


def outline_world(mask, factor, offset_x, offset_y, max_points):
    boundary = trace_boundary(mask)
    points = [(x, y) for (y, x) in boundary]
    simplified = simplify_closed(points, max_points)
    return [to_world(offset_x + x * factor, offset_y + y * factor) for (x, y) in simplified]


def shell_back_face(back, size):
    """Canva page 6 (clear shell over the dark disc and metal hub) as the cartridge's back cap.
    Mirrored so it reads correctly from behind, stretched to the front shell's size, and made opaque
    inside the rounded outline so the back cap hides the disc planes."""
    x0, y0, x1, y1 = alpha_bbox(back)
    back = back.crop((x0, y0, x1, y1)).transpose(Image.FLIP_LEFT_RIGHT).resize(size, Image.LANCZOS)
    base = Image.new("RGBA", size, (13, 15, 22, 255))
    base.alpha_composite(back)
    outline = Image.fromarray(((np.array(back.getchannel("A")) > 8) * 255).astype("uint8"))
    base.putalpha(outline.filter(ImageFilter.GaussianBlur(1.0)))
    return base


def _components(mask):
    """4-connected components of a boolean mask, as arrays of (y, x)."""
    h, w = mask.shape
    seen = np.zeros_like(mask, bool)
    out = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        queue, points = deque([(y0, x0)]), []
        seen[y0, x0] = True
        while queue:
            y, x = queue.popleft()
            points.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        out.append(np.array(points))
    return out


def detect_screws(img):
    """Corner screw heads (bright metal inside the dark wells): [[u, v], ...] in UV space (v up), plus the
    median head radius as a fraction of the texture width."""
    lum = np.asarray(img.convert("RGB")).astype(float) @ [0.299, 0.587, 0.114]
    h, w = lum.shape
    centres, radii = [], []
    for fx, fy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        x0, y0 = int(fx * w * 0.78), int(fy * h * 0.78)
        corner = lum[y0 : y0 + int(h * 0.22) : 2, x0 : x0 + int(w * 0.22) : 2]
        head = max(_components(corner > 150), key=len)
        ys, xs = head[:, 0] * 2 + y0, head[:, 1] * 2 + x0
        centres.append([round((xs.min() + xs.max()) / 2 / w, 5), round(1 - (ys.min() + ys.max()) / 2 / h, 5)])
        radii.append(max(xs.max() - xs.min(), ys.max() - ys.min()) / 2 / w)
    return centres, round(float(np.median(radii)), 5)


def normal_map(img, size=1024, strength=5.0):
    """Tangent-space normal map from the artwork's fine detail (luminance high-pass): plastic grain, ridges,
    screw wells. Encoded for three.js (+x right, +y up)."""
    small = img.convert("L").resize((size, round(size * img.height / img.width)), Image.LANCZOS)
    lum = np.asarray(small).astype(float) / 255
    blurred = np.asarray(small.filter(ImageFilter.GaussianBlur(6))).astype(float) / 255
    height = lum - blurred
    d_rows, d_cols = np.gradient(height)
    nx, ny = -d_cols * strength, d_rows * strength  # rows grow downward, v grows upward
    nz = np.ones_like(nx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / length, ny / length, nz / length], axis=-1) * 0.5 + 0.5
    return Image.fromarray((rgb * 255).round().astype("uint8"), "RGB")


def draw_eject_glyph(key):
    """Prints an eject symbol inside the red key's round button (page 11 has a plain circle)."""
    from PIL import ImageDraw

    w, h = key.size
    # Circle centre and radius measured on the page 11 crop, as fractions of the key face.
    cx, cy, r = w * 0.538, h * 0.479, w * 0.2
    tri_w, tri_h, bar_h, gap = r * 0.95, r * 0.52, r * 0.15, r * 0.14
    top = cy - (tri_h + gap + bar_h) / 2
    layer = Image.new("RGBA", key.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for dy, colour in ((max(1, h * 0.004), (90, 8, 6, 150)), (0, (255, 238, 230, 235))):
        draw.polygon([(cx - tri_w / 2, top + tri_h + dy), (cx + tri_w / 2, top + tri_h + dy), (cx, top + dy)], fill=colour)
        bar_top = top + tri_h + gap + dy
        draw.rectangle((cx - tri_w / 2, bar_top, cx + tri_w / 2, bar_top + bar_h), fill=colour)
    key = key.copy()
    key.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.6)))
    return key


def build_disc_face(cover, canva_disc, size=1536, cover_scale=0.84, hub_ratio=0.26, art_offset_y=0.06):
    """Album cover printed on a MiniDisc: blurred bleed, cover inset so the title survives the round edge,
    the real hub from the Canva disc on top, faint grooves and a dark rim."""
    from PIL import ImageDraw, ImageFilter

    face = Image.new("RGBA", (size, size), (6, 6, 12, 255))
    bleed = cover.resize((round(size * 1.35), round(size * 1.35)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(size * 0.03))
    face.alpha_composite(bleed, (-(bleed.width - size) // 2, -(bleed.height - size) // 2))
    face = Image.blend(face, Image.new("RGBA", (size, size), (6, 6, 12, 255)), 0.35)

    inset = round(size * cover_scale)
    art = cover.resize((inset, inset), Image.LANCZOS)
    feather = Image.new("L", (inset, inset), 0)
    edge = round(inset * 0.035)
    ImageDraw.Draw(feather).rectangle((edge, edge, inset - edge, inset - edge), fill=255)
    art.putalpha(feather.filter(ImageFilter.GaussianBlur(edge * 0.8)))
    # Nudged down so the figure clears the hub while the title stays inside the rim.
    face.alpha_composite(art, ((size - inset) // 2, (size - inset) // 2 + round(size * art_offset_y)))

    # Faint concentric grooves.
    grooves = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(grooves)
    centre = size / 2
    for i, radius in enumerate(np.linspace(size * 0.16, size * 0.49, 140)):
        shade = 255 if i % 2 else 0
        draw.ellipse((centre - radius, centre - radius, centre + radius, centre + radius), outline=(shade, shade, shade, 9))
    face.alpha_composite(grooves)

    # Real hub from the Canva disc.
    hub = canva_disc.resize((size, size), Image.LANCZOS)
    hub_mask = Image.new("L", (size, size), 0)
    r = size * hub_ratio / 2
    ImageDraw.Draw(hub_mask).ellipse((centre - r, centre - r, centre + r, centre + r), fill=255)
    hub.putalpha(hub_mask.filter(ImageFilter.GaussianBlur(size * 0.006)))
    face.alpha_composite(hub)

    # Dark rim and circular alpha.
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rim).ellipse((6, 6, size - 6, size - 6), outline=(10, 10, 16, 235), width=round(size * 0.012))
    face.alpha_composite(rim)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((2, 2, size - 2, size - 2), fill=255)
    face.putalpha(mask.filter(ImageFilter.GaussianBlur(1.2)))
    return face


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(Path.home() / "Downloads/CD PLYAER MYINDSOUND/transparent"))
    parser.add_argument(
        "--disc-art",
        default=str(Path.home() / "Downloads/CD PLYAER MYINDSOUND/lit-cover-clean.png"),
        help="Square album cover printed on the disc (falls back to Canva page 15 if missing)",
    )
    args = parser.parse_args()
    src = Path(args.source)
    if not (src / "13.png").exists():
        sys.exit(f"Canva export not found in {src}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    page = lambda n: Image.open(src / f"{n}.png").convert("RGBA")
    sizes = {}
    geometry = {"units": "body width = 1.0, origin body centre, +y up", "source": "Canva DAHAUDNdp9k"}

    # Body (13): crop to bbox; trace outline + window hole at 1/4 resolution.
    body = page(13).crop(BODY)
    factor = 4
    small = body.resize((body.width // factor, body.height // factor), Image.BILINEAR)
    mask = np.array(small.getchannel("A")) > 128
    geometry["body"] = {
        "rect": rect_world(*BODY),
        "outline": outline_world(mask, factor, BODY[0], BODY[1], 48),
        "hole": outline_world(largest_hole(mask), factor, BODY[0], BODY[1], 64),
    }
    sizes["body.webp"] = save_webp(body, "body.webp", 2048)

    # Registered small-canvas pages: 7 back plate, 8 empty tray, 10 glare.
    def registered(n, name, max_side, key):
        img = page(n)
        x0, y0, x1, y1 = alpha_bbox(img)
        crop = img.crop((x0, y0, x1, y1))
        geometry[key] = {"rect": rect_world(x0 * SX + OX, y0 * SY + OY, x1 * SX + OX, y1 * SY + OY)}
        sizes[name] = save_webp(crop, name, max_side)

    registered(7, "backplate.webp", 1024, "backplate")
    registered(8, "tray.webp", 1024, "tray")
    registered(10, "glare.webp", 1024, "glare")

    # Cartridge shell (16) and LIT disc (15) share the large canvas.
    shell = page(16)
    sx0, sy0, sx1, sy1 = alpha_bbox(shell)
    disc = page(15)
    dx0, dy0, dx1, dy1 = alpha_bbox(disc)
    disc_cx, disc_cy = (dx0 + dx1) / 2, (dy0 + dy1) / 2
    disc_r = ((dx1 - dx0) + (dy1 - dy0)) / 4
    geometry["cartridge"] = {
        "rect": rect_world(sx0, sy0, sx1, sy1),
        # Disc window inside the shell texture, in shell UV space (v up).
        "discUv": {
            "cx": round((disc_cx - sx0) / (sx1 - sx0), 5),
            "cy": round(1 - (disc_cy - sy0) / (sy1 - sy0), 5),
            "rx": round(disc_r / (sx1 - sx0), 5),
            "ry": round(disc_r / (sy1 - sy0), 5),
        },
    }
    # hubRing: the clamp plate's metal ring on the disc face, as fractions of the disc radius.
    geometry["disc"] = {"center": to_world(disc_cx, disc_cy), "radius": round(disc_r / body_w, 5), "hubRing": [0.105, 0.145]}
    # 2048 px (source is about 2340 px) so the eject inspector can zoom in.
    shell_crop = shell.crop((sx0, sy0, sx1, sy1))
    sizes["shell.webp"] = save_webp(shell_crop, "shell.webp", 2048)
    back_face = shell_back_face(page(6), shell_crop.size)
    sizes["shell-back.webp"] = save_webp(back_face, "shell-back.webp", 1536)
    # Realism layer (cartridge-detail.ts): surface normals, and where the 3D screws and hub go.
    sizes["shell-normal.webp"] = save_webp(normal_map(shell_crop), "shell-normal.webp", 1024)
    sizes["shell-back-normal.webp"] = save_webp(normal_map(back_face), "shell-back-normal.webp", 1024)
    front_screws, front_radius = detect_screws(shell_crop)
    back_screws, back_radius = detect_screws(back_face)
    geometry["cartridge"]["screws"] = {
        "front": front_screws,
        "back": back_screws,
        "radius": round((front_radius + back_radius) / 2, 5),
    }
    # Metal hub ring on the back (page 6), measured from its radial luminance profile, in shell-width units.
    geometry["cartridge"]["backHub"] = {"u": 0.5, "v": 0.5, "outer": 0.174, "inner": 0.151, "cap": 0.03}
    # Square crop centred on the disc so rotation stays true.
    half = round(disc_r)
    canva_disc = disc.crop((round(disc_cx) - half, round(disc_cy) - half, round(disc_cx) + half, round(disc_cy) + half))
    art_path = Path(args.disc_art).expanduser()
    disc_face = build_disc_face(Image.open(art_path).convert("RGBA"), canva_disc) if art_path.exists() else canva_disc
    sizes["disc.webp"] = save_webp(disc_face, "disc.webp", 1536)
    clear = page(3)
    cx0, cy0, cx1, cy1 = alpha_bbox(clear)
    ccx, ccy, chalf = (cx0 + cx1) / 2, (cy0 + cy1) / 2, max(cx1 - cx0, cy1 - cy0) / 2
    # Page 3 (clear disc) shares page 5's canvas with the LIT disc, so its size is relative to page 5's disc.
    px0, py0, px1, py1 = alpha_bbox(page(5))
    geometry["clearDisc"] = {"radiusRatio": round(chalf / (((px1 - px0) + (py1 - py0)) / 4), 5)}
    sizes["disc-clear.webp"] = save_webp(
        clear.crop((round(ccx - chalf), round(ccy - chalf), round(ccx + chalf), round(ccy + chalf))),
        "disc-clear.webp",
        1024,
    )

    # Cartridge label: the "Do Not Duplicate" sticker from page 14 (same canvas as the shell).
    lx0, ly0, lx1, ly1 = DND_LABEL
    label = page(14).crop((lx0, ly0, lx1, ly1))
    label_alpha = Image.fromarray(((np.array(label.getchannel("A")) >= 250) * 255).astype("uint8"))
    label.putalpha(label_alpha.filter(ImageFilter.GaussianBlur(0.8)))
    geometry["label"] = {"rect": rect_world(lx0, ly0, lx1, ly1)}
    sizes["label.webp"] = save_webp(label, "label.webp", 1024)

    # Keys: faces cut from the composite (11), which has the icons.
    composite = page(11)
    keys = []
    for key_id, x0, x1 in KEYS:
        crop = composite.crop((x0, KEY_TOP, x1, composite.height))
        a = np.array(crop.getchannel("A"))
        rows = np.where((a > 40).any(axis=1))[0]
        bottom = KEY_TOP + int(rows.max()) + 1
        crop = crop.crop((0, 0, x1 - x0, bottom - KEY_TOP))
        keys.append({"id": key_id, "rect": rect_world(x0, KEY_TOP, x1, bottom)})
        if key_id == "red":
            crop = draw_eject_glyph(crop)
        sizes[f"key-{key_id}.webp"] = save_webp(crop, f"key-{key_id}.webp", 512)
    geometry["keys"] = keys
    geometry["bodyBottom"] = to_world(0, BODY[3])[1]

    ax0, ay0, ax1, ay1 = alpha_bbox(composite)
    sizes["fallback-deck.webp"] = save_webp(composite.crop((ax0, ay0, ax1, ay1)), "fallback-deck.webp", 1600)

    GEOMETRY_OUT.parent.mkdir(parents=True, exist_ok=True)
    GEOMETRY_OUT.write_text(json.dumps(geometry, indent=1) + "\n")

    total = sum(size for size, _ in sizes.values())
    for name, (size, dims) in sorted(sizes.items()):
        print(f"  {name:22s} {dims[0]:>4}x{dims[1]:<4} {size / 1024:7.0f} KB")
    print(f"  total {total / 1024 / 1024:.2f} MB (budget 4 MB)")
    print(f"  body outline {len(geometry['body']['outline'])} pts, hole {len(geometry['body']['hole'])} pts")
    if total > BUDGET_BYTES:
        sys.exit("Texture budget exceeded")


if __name__ == "__main__":
    main()
