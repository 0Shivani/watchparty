from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(__file__).parent

HIBISCUS = (224, 164, 176)
HIBISCUS_STRIPE = (198, 126, 141)
CHERRY = (124, 1, 22)
BUTTER = (247, 227, 160)
BUTTER_LIGHT = (255, 244, 209)

# Rendered at this multiple of the target size, then downsampled for clean edges.
SUPERSAMPLE = 8

# Wordmark is unreadable below this pixel size, so the mark stands alone there.
MIN_SIZE_FOR_WORDMARK = 48

# Retro display faces, best first. Cooper Black and Showcard Gothic ship with
# Microsoft Office rather than Windows itself, hence the fallbacks.
WORDMARK_FONTS = ("COOPBL.TTF", "SHOWG.TTF", "BAUHS93.TTF", "arialbd.ttf", "DejaVuSans-Bold.ttf")

WORDMARK_ANGLE = 11  # degrees counter-clockwise, so the word rises to the right
WORDMARK_SLANT = 0.17  # oblique shear, applied before the rotation
WORDMARK_WIDTH = 0.50  # fraction of the canvas, keeps the corners inside the taper
WORDMARK_MAX_HEIGHT = 0.26
WORDMARK_CENTER = (0.50, 0.72)

# Popcorn kernels as (center_x, center_y, radius) fractions of the canvas.
KERNELS = [
    (0.50, 0.17, 0.105),
    (0.29, 0.24, 0.100),
    (0.71, 0.24, 0.100),
    (0.39, 0.33, 0.098),
    (0.61, 0.33, 0.098),
    (0.17, 0.35, 0.092),
    (0.83, 0.35, 0.092),
    (0.26, 0.43, 0.085),
    (0.50, 0.42, 0.095),
    (0.74, 0.43, 0.085),
]

# Lobes that give each kernel its popped, cauliflower silhouette.
LOBES = [(0.0, 0.0, 0.80), (-0.50, -0.35, 0.62), (0.50, -0.35, 0.62), (-0.45, 0.40, 0.58), (0.45, 0.40, 0.58)]

BOX_TOP = 0.44
BOX_BOTTOM = 0.93
BOX_TOP_INSET = 0.15
BOX_BOTTOM_INSET = 0.26
STRIPE_COUNT = 9  # odd, so the box reads symmetrically from either edge


def load_font(pixel_size: int):
    for candidate in WORDMARK_FONTS:
        try:
            return ImageFont.truetype(candidate, pixel_size)
        except OSError:
            continue
    return ImageFont.load_default()


def circle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def draw_popcorn(draw: ImageDraw.ImageDraw, s: float) -> None:
    # Solid mound behind the kernels so their overlaps never leave gaps.
    draw.ellipse([0.15 * s, 0.16 * s, 0.85 * s, 0.52 * s], fill=BUTTER)

    for cx, cy, r in KERNELS:
        px, py, pr = cx * s, cy * s, r * s
        for ox, oy, scale in LOBES:
            circle(draw, px + ox * pr, py + oy * pr, pr * scale, BUTTER)

    for cx, cy, r in KERNELS:
        px, py, pr = cx * s, cy * s, r * s
        circle(draw, px - 0.34 * pr, py - 0.42 * pr, pr * 0.30, BUTTER_LIGHT)


def face_x(across: float, down: float) -> float:
    """X of a point `across` the box face at `down` its height, following the taper."""
    left = BOX_TOP_INSET + (BOX_BOTTOM_INSET - BOX_TOP_INSET) * down
    return left + (1 - 2 * left) * across


def draw_box(draw: ImageDraw.ImageDraw, s: float) -> None:
    body = [
        (BOX_TOP_INSET * s, BOX_TOP * s),
        ((1 - BOX_TOP_INSET) * s, BOX_TOP * s),
        ((1 - BOX_BOTTOM_INSET) * s, BOX_BOTTOM * s),
        (BOX_BOTTOM_INSET * s, BOX_BOTTOM * s),
    ]
    draw.polygon(body, fill=HIBISCUS)

    # Stripes converge with the taper, as they would on a real folded box.
    for index in range(1, STRIPE_COUNT, 2):
        near, far = index / STRIPE_COUNT, (index + 1) / STRIPE_COUNT
        draw.polygon(
            [
                (face_x(near, 0.0) * s, BOX_TOP * s),
                (face_x(far, 0.0) * s, BOX_TOP * s),
                (face_x(far, 1.0) * s, BOX_BOTTOM * s),
                (face_x(near, 1.0) * s, BOX_BOTTOM * s),
            ],
            fill=HIBISCUS_STRIPE,
        )

    draw.line(body + [body[0]], fill=CHERRY, width=max(1, int(0.028 * s)), joint="curve")


def build_wordmark(s: float) -> Image.Image:
    """Render "picnic", lean it into an oblique, then tilt it as one block."""
    text = "picnic"
    font = load_font(max(8, int(0.26 * s)))

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = probe.textbbox((0, 0), text, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]

    pad = max(2, int(text_h * 0.35))
    layer_h = text_h + 2 * pad
    layer = Image.new("RGBA", (text_w + 2 * pad + int(layer_h * WORDMARK_SLANT), layer_h), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=CHERRY)

    # Affine maps output back to input, so this pushes the top of the word right.
    layer = layer.transform(
        layer.size,
        Image.AFFINE,
        (1, WORDMARK_SLANT, -WORDMARK_SLANT * layer_h, 0, 1, 0),
        resample=Image.BICUBIC,
    )
    layer = layer.rotate(WORDMARK_ANGLE, resample=Image.BICUBIC, expand=True)
    layer = layer.crop(layer.getbbox())

    scale = min(WORDMARK_WIDTH * s / layer.width, WORDMARK_MAX_HEIGHT * s / layer.height)
    return layer.resize((max(1, round(layer.width * scale)), max(1, round(layer.height * scale))), Image.LANCZOS)


def paste_wordmark(img: Image.Image, s: float) -> None:
    wordmark = build_wordmark(s)
    left = round(WORDMARK_CENTER[0] * s - wordmark.width / 2)
    top = round(WORDMARK_CENTER[1] * s - wordmark.height / 2)
    img.alpha_composite(wordmark, (left, top))


def draw_icon(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw_popcorn(draw, s)
    draw_box(draw, s)
    if size >= MIN_SIZE_FOR_WORDMARK:
        paste_wordmark(img, s)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    for size, filename in ((512, "icon-master.png"), (128, "icon128.png"), (48, "icon48.png"), (16, "icon16.png")):
        draw_icon(size).save(OUT_DIR / filename)
    print("Generated icon-master.png, icon128.png, icon48.png, icon16.png")


if __name__ == "__main__":
    main()
