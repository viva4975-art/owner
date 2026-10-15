"""App-Icons aus dem Firmenlogo (Globus mit „VD“) erzeugen – PWA, Android (Play Store) und App Store.

Quelle: Bildmarke aus dem Briefpapier (assets/briefpapier/viva-deluxe-a4.jpg, höchste vorhandene Auflösung).
Aufruf: python3 -I scripts/app-icons.py   (Pillow nötig)
Schreibt: assets/web/app-icon-{192,512,1024}.png, app-icon-maskable-512.png, apple-touch-icon.png, app-mark.png,
          mobile-app/resources/icon.png (1024, App Store) und die Android-Startsymbole (mipmap-*).
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'assets/web'
RES = ROOT / 'mobile-app/android/app/src/main/res'


def mark() -> Image.Image:
    """Bildmarke freistellen: weißer Hintergrund → durchsichtig (Farben entmischt), Schriftzug abgedeckt."""
    im = Image.open(ROOT / 'assets/briefpapier/viva-deluxe-a4.jpg').convert('RGB').crop((150, 20, 520, 320))
    ImageDraw.Draw(im).rectangle((305, 120, 370, 300), fill='white')  # „V“/„GE“ des Schriftzugs
    diff = ImageChops.difference(im, Image.new('RGB', im.size, 'white')).convert('L').point(lambda v: 255 if v > 40 else 0)
    im = im.crop(diff.getbbox())
    out = Image.new('RGBA', im.size)
    px, po = im.load(), out.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            a = max(255 - r, 255 - g, 255 - b)
            if a < 12:
                po[x, y] = (0, 0, 0, 0)
                continue
            f = 255 / a
            po[x, y] = tuple(max(0, min(255, round(255 - (255 - c) * f))) for c in (r, g, b)) + (a,)
    return out


def place(m: Image.Image, size: int, scale: float, bg=(255, 255, 255, 255)) -> Image.Image:
    """Marke mittig, Breite = scale × Kantenlänge (leicht nach oben versetzt wirkt optisch mittig)."""
    canvas = Image.new('RGBA', (size, size), bg)
    w = round(size * scale)
    h = round(m.height * w / m.width)
    r = m.resize((w, h), Image.LANCZOS)
    if w > m.width:
        r = r.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    canvas.alpha_composite(r, ((size - w) // 2, (size - h) // 2))
    return canvas


def rounded(img: Image.Image, radius: float) -> Image.Image:
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius, fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, mask=mask)
    return out


def circle(img: Image.Image) -> Image.Image:
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.width - 1, img.height - 1), fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, mask=mask)
    return out


def main() -> None:
    m = mark()
    m.save(WEB / 'app-mark.png')
    rgb = lambda i: i.convert('RGB')  # App Store verlangt Icons ohne Transparenz
    rgb(place(m, 1024, 0.74)).save(WEB / 'app-icon-1024.png')
    (ROOT / 'mobile-app/resources').mkdir(exist_ok=True)
    rgb(place(m, 1024, 0.74)).save(ROOT / 'mobile-app/resources/icon.png')
    rgb(place(m, 512, 0.74)).save(WEB / 'app-icon-512.png')
    rgb(place(m, 192, 0.76)).save(WEB / 'app-icon-192.png')
    rgb(place(m, 180, 0.74)).save(WEB / 'apple-touch-icon.png')
    rgb(place(m, 512, 0.6)).save(WEB / 'app-icon-maskable-512.png')  # sichere Zone 80 %
    # Android: Alt-Symbol 48 dp, adaptives Symbol 108 dp (sichtbar sind die inneren 72 dp)
    for d, f in {'ldpi': 0.75, 'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
        out = RES / f'mipmap-{d}'
        legacy = round(48 * f)
        base = place(m, legacy, 0.78)
        rounded(base, legacy * 0.18).save(out / 'ic_launcher.png')
        circle(place(m, legacy, 0.7)).save(out / 'ic_launcher_round.png')
        adaptive = round(108 * f)
        place(m, adaptive, 0.6, bg=(0, 0, 0, 0)).save(out / 'ic_launcher_foreground.png')
        Image.new('RGB', (adaptive, adaptive), 'white').save(out / 'ic_launcher_background.png')
    print('Icons geschrieben.')


if __name__ == '__main__':
    main()
