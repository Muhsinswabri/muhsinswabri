"""Cut the portfolio avatar out of its black studio background.

The avatar render (images/swabri-avatar-source.webp) sits on near-black, with a dark haze (and
an orange glow on the right) around the suit. The hero places the character over a purple aura,
so the background has to become transparent without losing the dark hair and suit, which are
almost as dark as the haze. Head and body are cut differently:

Head and hair (above the neck)
  1. A solid matte: blurred brightness above a threshold, holes filled, largest shape kept,
     pulled in by 2 px (the render's edges are anti-aliased against black), feathered by ~1 px.
  2. A light matte: anything brighter than the background noise keeps an alpha equal to its
     brightness, so curls, stray strands and rim light stay as soft light.
  Colours are un-premultiplied against black, so they composite back exactly over dark pages.

Body (neck, shirt, suit)
  The suit is outlined by a rim light. Each row is filled between its outermost rim pixels, the
  row ends are median-filtered (no spikes), and the mask is blurred and re-thresholded into a
  smooth ~2 px anti-aliased contour. The haze and glow outside the rim are dropped. Edge pixels
  take the colour of the suit just inside the edge, so no dark haze is mixed into the fringe.

Both are blended over a few rows at the neck. Finally every transparent pixel gets the colour of
the nearest visible one, so scaling (browser or WebGL mipmaps) never pulls in a foreign colour.

Writes the cutout and, next to it, <name>.data.js (the cutout as a data: URL, for file:// pages).

Usage (from the repository root):
    python -I tools/prepare_avatar.py images/swabri-avatar-source.webp images/swabri-avatar.webp
Requires Pillow, numpy and scipy.
"""

import base64
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

# Source rows (pixels, y down) where the cut switches from the head method to the body method.
BODY_FROM = 790
BODY_FULL = 830
LIGHT_UNTIL = 700       # last row (bottom of the ears) where faint hair/rim light is kept
RIM = 70              # blurred brightness that counts as the suit's rim light (haze stays below ~60)
PEAK_SEARCH = 7         # px searched inward for the rim's brightest pixel
INSET = 0.5             # px the body contour sits inside that pixel


def nearest_fill(colour: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """Copy into every pixel outside `keep` the colour of the nearest pixel inside it."""
    _, (iy, ix) = ndimage.distance_transform_edt(~keep, return_indices=True)
    return colour[iy, ix]


def first_peak(values: np.ndarray) -> int:
    """Index of the first local maximum (where brightness stops rising), 0 if none."""
    for i in range(len(values) - 1):
        if values[i + 1] <= values[i]:
            return i
    return len(values) - 1


def head_matte(rgb: np.ndarray, bright: np.ndarray):
    solid = ndimage.gaussian_filter(bright, 1.5) > 30
    solid = ndimage.binary_closing(solid, iterations=3)
    solid = np.vstack([solid, np.ones((1, solid.shape[1]), bool)])   # the bust runs off the bottom
    solid = ndimage.binary_fill_holes(solid)[:-1]
    solid = ndimage.binary_opening(solid, iterations=2)
    labels, count = ndimage.label(solid)
    if count == 0:
        raise SystemExit("No subject found")
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    solid = labels == (int(np.argmax(sizes)) + 1)
    solid = ndimage.binary_erosion(solid, iterations=2)
    solid_alpha = np.clip(ndimage.gaussian_filter(solid.astype(np.float32), 1.0) * 1.6 - 0.3, 0, 1)
    light_alpha = np.clip((bright - 12.0) / 120.0, 0, 1)
    # Soft light is only wanted for hair and ears; around the jaw and neck it would keep haze.
    rows = np.arange(bright.shape[0], dtype=np.float32)[:, None]
    light_alpha *= np.clip((LIGHT_UNTIL + 40 - rows) / 40, 0, 1)
    alpha = np.maximum(solid_alpha, light_alpha)
    colour = np.clip(rgb / np.maximum(alpha, 1e-3)[..., None], 0, 255)
    return alpha, colour


def body_matte(rgb: np.ndarray, bright: np.ndarray):
    h, w = bright.shape
    blurred = ndimage.gaussian_filter(bright, 1.2)
    left = np.full(h, -1.0)
    right = np.full(h, -1.0)
    for y in range(BODY_FROM - 20, h):
        row = blurred[y]
        xs = np.flatnonzero(row > RIM)
        if xs.size:
            # The threshold is first crossed in the glow fading out from the rim; the suit's
            # real edge is the rim's brightest pixel, a few px further in.
            left[y] = xs[0] + first_peak(row[xs[0] : xs[0] + PEAK_SEARCH])
            right[y] = xs[-1] - first_peak(row[max(0, xs[-1] - PEAK_SEARCH + 1) : xs[-1] + 1][::-1])
    rows = np.flatnonzero(left >= 0)
    left[rows] = ndimage.median_filter(left[rows], size=9, mode="nearest")
    right[rows] = ndimage.median_filter(right[rows], size=9, mode="nearest")
    # Half a pixel in from the rim's peak, so none of the render's anti-aliasing against the dark
    # haze is left on the outside.
    left[rows] += INSET
    right[rows] -= INSET
    mask = np.zeros((h, w), np.float32)
    for y in rows:
        mask[y, int(round(left[y])) : int(round(right[y])) + 1] = 1
    # Rows place steep edges well but not the shallow shoulder tops; columns do the opposite.
    # Scanning each column down to the rim's peak gives the top contour, and the body is the
    # part of the row spans below it.
    start = BODY_FROM - 20
    top = np.full(w, float(h))
    for x in range(w):
        col = blurred[start:, x]
        ys = np.flatnonzero(col > RIM)
        if ys.size:
            top[x] = start + ys[0] + first_peak(col[ys[0] : ys[0] + PEAK_SEARCH]) + INSET
    cols = np.flatnonzero(top < h)
    top[cols] = ndimage.median_filter(top[cols], size=9, mode="nearest")
    mask[np.arange(h)[:, None] < np.round(top)[None, :]] = 0
    # Smooth contour: blur, then a ~2 px ramp around the 0.5 level. Edge-padded so the image
    # border (the suit runs off the bottom and sides) stays fully opaque.
    pad = 8
    soft = ndimage.gaussian_filter(np.pad(mask, pad, mode="edge"), 1.6)[pad:-pad, pad:-pad]
    alpha = np.clip((soft - 0.5) * 2.2 + 0.5, 0, 1)
    # Edge colour: the suit a little inside the edge, not the haze the render blended into it.
    core = ndimage.binary_erosion(alpha >= 0.999, iterations=2)
    colour = nearest_fill(rgb, core)
    return alpha, colour


def cut_out(src_path: str, out_path: str) -> None:
    rgb = np.asarray(Image.open(src_path).convert("RGB")).astype(np.float32)
    bright = rgb.max(axis=2)

    head_a, head_c = head_matte(rgb, bright)
    body_a, body_c = body_matte(rgb, bright)
    rows = np.arange(rgb.shape[0], dtype=np.float32)
    t = np.clip((rows - BODY_FROM) / (BODY_FULL - BODY_FROM), 0, 1)
    wgt = (t * t * (3 - 2 * t))[:, None]
    alpha = head_a * (1 - wgt) + body_a * wgt
    colour = head_c * (1 - wgt[..., None]) + body_c * wgt[..., None]

    # Fully transparent pixels: the nearest visible colour (safe for scaling and mipmaps).
    colour = nearest_fill(colour, alpha > 0.02)
    out = np.dstack([colour, alpha * 255]).round().clip(0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path, "WEBP", quality=90, alpha_quality=100, method=6, exact=True)

    # The same picture as a script, for pages opened straight from disk (file://): browsers
    # refuse to hand a file:// image to WebGL, but accept a data: URL. avatar3d.js loads this
    # only in that case.
    data = base64.b64encode(Path(out_path).read_bytes()).decode("ascii")
    Path(out_path).with_suffix(".data.js").write_text(
        "// Generated by tools/prepare_avatar.py from " + Path(out_path).name + ". Do not edit.\n"
        'window.SwabriAvatarPortrait = "data:image/webp;base64,' + data + '";\n',
        encoding="ascii",
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    cut_out(sys.argv[1], sys.argv[2])
