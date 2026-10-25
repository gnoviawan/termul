"""Builds the TTF files GPUIX registers from the WOFF2 fonts the web client loads.

GPUIX registerFont() takes TTF/OTF only, and GPUI picks faces by weight, so
each variable font becomes static instances at the weights Termul uses.
Inter's fontsource subsets are merged back into one face per weight.
Two OpenType features the web client turns on are frozen into the cmap,
because GPUIX cannot set font features per element:
  - Paper Mono `zero` (index.css: `.font-mono { font-variant-numeric: slashed-zero }`)
  - Inter `tnum`, as a separate family for `tabular-nums`

Italics: Inter's real italic masters become "Inter Variable" italic faces.
Paper Mono has no italic, so the browser draws a synthetic oblique; the
Paper Mono italic faces here are the same skew baked into the outlines
(Blink's synthetic italic, SkFont skewX -1/4), for the prose faces and the
terminal's own Paper Mono files (src/terminal/fonts).

Run from apps/gpuix (needs the repo root node_modules):
  uv run --with fonttools --with brotli python -I tools/style/build-fonts.py
"""

import os
import shutil
import sys
import tempfile

from fontTools.merge import Merger
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, "..", ".."))
REPO = os.path.normpath(os.path.join(APP, "..", ".."))
OUT = os.path.join(APP, "assets", "fonts")
INTER_DIR = os.path.join(REPO, "node_modules", "@fontsource-variable", "inter", "files")
PAPER_MONO = os.path.join(REPO, "src", "renderer", "assets", "fonts", "paper-mono", "PaperMono[wght].woff2")
INTER_SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "greek-ext", "vietnamese"]
WEIGHTS = {400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold"}
TERMINAL_FONTS = os.path.join(APP, "src", "terminal", "fonts")
# Blink's synthetic italic: SkFont::setSkewX(-1/4), x' = x + y/4 in font units.
OBLIQUE_SKEW = 0.25
OBLIQUE_ANGLE = -14.04


def instance(path, weight):
    font = TTFont(path)
    font.flavor = None
    return instantiateVariableFont(font, {"wght": weight})


def freeze(font, feature):
    """Point the cmap at the glyphs a single-substitution feature selects."""
    gsub = font["GSUB"].table
    lookups = set()
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag == feature:
            lookups.update(record.Feature.LookupListIndex)
    if not lookups:
        raise SystemExit(f"feature {feature} not found")
    mapping = {}
    for index in lookups:
        lookup = gsub.LookupList.Lookup[index]
        for sub in lookup.SubTable:
            if lookup.LookupType == 7:
                sub = sub.ExtSubTable
            if hasattr(sub, "mapping"):
                mapping.update(sub.mapping)
    changed = 0
    for table in font["cmap"].tables:
        for code, glyph in list(table.cmap.items()):
            if glyph in mapping:
                table.cmap[code] = mapping[glyph]
                changed += 1
    return changed


def italic_style(weight):
    return "Italic" if weight == 400 else f"{WEIGHTS[weight]} Italic"


def rename(font, family, weight, italic=False):
    style = italic_style(weight) if italic else WEIGHTS[weight]
    postscript = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    name = font["name"]
    for record in list(name.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=record.nameID)
    name.setName(family, 1, 3, 1, 0x409)
    name.setName(style, 2, 3, 1, 0x409)
    name.setName(f"{postscript};termul-gpuix", 3, 3, 1, 0x409)
    name.setName(f"{family} {style}", 4, 3, 1, 0x409)
    name.setName(postscript, 6, 3, 1, 0x409)
    name.setName(family, 16, 3, 1, 0x409)
    name.setName(style, 17, 3, 1, 0x409)
    font["OS/2"].usWeightClass = weight
    bold = weight == 700
    if italic:
        selection = 0b1 | (0b100000 if bold else 0)
    else:
        selection = 0b100000 if bold else 0b1000000
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0b1100001) | selection
    font["head"].macStyle = (1 if bold else 0) | (0b10 if italic else 0)


def oblique(font):
    """Skew every outline the way Blink's synthetic italic does. Advances stay."""
    glyph_set = font.getGlyphSet()
    glyf = font["glyf"]
    for name in font.getGlyphOrder():
        if glyf[name].numberOfContours == 0:
            continue
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(TransformPen(pen, (1, 0, OBLIQUE_SKEW, 1, 0, 0)))
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
    font["post"].italicAngle = OBLIQUE_ANGLE
    font["hhea"].caretSlopeRise = 4
    font["hhea"].caretSlopeRun = 1
    return font


def save(font, filename):
    path = os.path.join(OUT, filename)
    font.save(path)
    print(f"wrote {os.path.relpath(path, APP)} ({os.path.getsize(path)} bytes)")


def inter(weight, tmp, style="normal"):
    paths = []
    for subset in INTER_SUBSETS:
        static = instance(os.path.join(INTER_DIR, f"inter-{subset}-wght-{style}.woff2"), weight)
        path = os.path.join(tmp, f"inter-{subset}-{weight}-{style}.ttf")
        static.save(path)
        paths.append(path)
    return Merger().merge(paths)


def main():
    os.makedirs(OUT, exist_ok=True)
    shutil.copyfile(os.path.join(INTER_DIR, "..", "LICENSE"), os.path.join(OUT, "Inter-OFL.txt"))
    shutil.copyfile(os.path.join(os.path.dirname(PAPER_MONO), "OFL.txt"), os.path.join(OUT, "PaperMono-OFL.txt"))
    with tempfile.TemporaryDirectory() as tmp:
        for weight in WEIGHTS:
            font = inter(weight, tmp)
            rename(font, "Inter Variable", weight)
            save(font, f"Inter-{WEIGHTS[weight]}.ttf")
            tabular = inter(weight, tmp)
            print(f"  tnum remapped {freeze(tabular, 'tnum')} cmap entries")
            rename(tabular, "Inter Variable Tabular", weight)
            save(tabular, f"InterTabular-{WEIGHTS[weight]}.ttf")
            mono = instance(PAPER_MONO, weight)
            print(f"  zero remapped {freeze(mono, 'zero')} cmap entries")
            rename(mono, "Paper Mono", weight)
            save(mono, f"PaperMono-{WEIGHTS[weight]}.ttf")
            suffix = italic_style(weight).replace(" ", "")
            italic = inter(weight, tmp, "italic")
            rename(italic, "Inter Variable", weight, italic=True)
            save(italic, f"Inter-{suffix}.ttf")
            mono = oblique(instance(PAPER_MONO, weight))
            freeze(mono, "zero")
            rename(mono, "Paper Mono", weight, italic=True)
            save(mono, f"PaperMono-{suffix}.ttf")
    for weight in (400, 700):
        upright = os.path.join(TERMINAL_FONTS, f"PaperMono-{WEIGHTS[weight]}.ttf")
        mono = oblique(TTFont(upright))
        rename(mono, "Paper Mono", weight, italic=True)
        path = os.path.join(TERMINAL_FONTS, f"PaperMono-{italic_style(weight).replace(' ', '')}.ttf")
        mono.save(path)
        print(f"wrote {os.path.relpath(path, APP)} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    sys.exit(main())
