#!/usr/bin/env python3
"""Re-renders the app icon, splash and wordmark PNGs from their sources.

    python3 scripts/render-brand-assets.py

Run from app/ after editing any assets/images/*.svg, or after changing the
wordmark font or tracking. Needs macOS (Quick Look renders the SVGs) and
Pillow plus fontTools (`pip3 install pillow fonttools`).

Quick Look always renders onto white, so every layer that must stay
transparent is rendered twice, over white and over black, and its alpha is
recovered from the difference. Skip that and the Android foreground,
monochrome and splash images come out as opaque white squares.
"""

import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageMath
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(APP, 'assets', 'images')
WORDMARK_FONT = os.path.join(APP, 'assets', 'fonts', 'Outfit_700Bold.ttf')
# Must match src/ui/components/wordmark.tsx.
WORDMARK_TRACKING = -40  # font units per letter, i.e. -0.04em
WORDMARK_INK = '#F4EDE2'  # Colors.dark.text; the splash is always dark
SIZE = 1024


def quicklook(svg_text, tmp, name):
    path = os.path.join(tmp, name + '.svg')
    with open(path, 'w') as f:
        f.write(svg_text)
    subprocess.run(['qlmanage', '-t', '-s', str(SIZE), '-o', tmp, path], check=True, capture_output=True)
    image = Image.open(path + '.png').convert('RGB')
    if image.size != (SIZE, SIZE):
        sys.exit(f'{name}: Quick Look rendered {image.size}, expected {SIZE}x{SIZE}')
    return image


def with_backdrop(svg, color):
    rect = f'<rect width="{SIZE}" height="{SIZE}" fill="{color}"/>'
    if '</defs>' in svg:
        return svg.replace('</defs>', '</defs>' + rect, 1)
    return re.sub(r'(<svg[^>]*>)', r'\1' + rect, svg, count=1)


def opaque(svg, tmp, name):
    return quicklook(svg, tmp, name)


def transparent(svg, tmp, name):
    white = quicklook(with_backdrop(svg, '#FFFFFF'), tmp, name + '-w').split()
    black = quicklook(with_backdrop(svg, '#000000'), tmp, name + '-b').split()
    diff = [ImageChops.subtract(w, b) for w, b in zip(white, black)]
    alpha = ImageMath.unsafe_eval("convert(255-(r+g+b)/3,'L')", r=diff[0], g=diff[1], b=diff[2])
    rgb = [ImageMath.unsafe_eval("convert(min(c*255/max(a,1),255),'L')", c=c, a=alpha) for c in black]
    return Image.merge('RGBA', rgb + [alpha])


def read(name):
    with open(os.path.join(IMAGES, name)) as f:
        return f.read()


def wordmark_svg():
    """Plain "mimoza" in Outfit Bold, centred in a 1024 square."""
    font = TTFont(WORDMARK_FONT)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    x, paths = 0, []
    for char in 'mimoza':
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        paths.append(pen.getCommands())
        x += glyphs[name].width + WORDMARK_TRACKING
    width = x - WORDMARK_TRACKING
    scale = SIZE * 0.8 / width
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}"><defs></defs>'
        f'<g transform="translate({(SIZE - width * scale) / 2:.2f} {SIZE / 2:.2f}) scale({scale:.5f})" '
        f'fill="{WORDMARK_INK}"><path d="{" ".join(paths)}"/></g></svg>'
    )


def fit(image, box, fill=0.62):
    """Crops to the ink and centres it in `box`, filling `fill` of the width at most."""
    ink = image.crop(image.getchannel('A').getbbox())
    scale = min(box[0] * fill / ink.width, box[1] * 0.5 / ink.height)
    ink = ink.resize((round(ink.width * scale), round(ink.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', box, (0, 0, 0, 0))
    canvas.paste(ink, ((box[0] - ink.width) // 2, (box[1] - ink.height) // 2), ink)
    return canvas


def main():
    out = lambda name: os.path.join(IMAGES, name)
    with tempfile.TemporaryDirectory() as tmp:
        icon = opaque(read('icon.svg'), tmp, 'icon')
        icon.save(out('icon.png'))
        icon.resize((48, 48), Image.LANCZOS).convert('RGBA').save(out('favicon.png'))

        opaque(read('android-icon-background.svg'), tmp, 'bg').resize((512, 512), Image.LANCZOS).save(
            out('android-icon-background.png')
        )
        transparent(read('android-icon-foreground.svg'), tmp, 'fg').resize((512, 512), Image.LANCZOS).save(
            out('android-icon-foreground.png')
        )
        transparent(read('android-icon-monochrome.svg'), tmp, 'mono').resize((432, 432), Image.LANCZOS).save(
            out('android-icon-monochrome.png')
        )
        transparent(read('splash-icon.svg'), tmp, 'splash').save(out('splash-icon.png'))
        transparent(read('notification-icon.svg'), tmp, 'notif').resize((384, 384), Image.LANCZOS).save(
            out('notification-icon.png')
        )

        # 600x240 = Android 12's 200x80dp branding image at 3x; the iOS
        # storyboard uses the same file (plugins/with-splash-wordmark.js).
        fit(transparent(wordmark_svg(), tmp, 'wordmark'), (600, 240)).save(out('splash-wordmark.png'))

    for name in ['icon.png', 'android-icon-foreground.png', 'android-icon-monochrome.png', 'splash-icon.png', 'notification-icon.png', 'splash-wordmark.png']:
        image = Image.open(out(name))
        print(f'{name:32} {image.size[0]}x{image.size[1]} {image.mode}')


if __name__ == '__main__':
    main()
