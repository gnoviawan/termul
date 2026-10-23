"""Builds the TTF files GPUIX registers from the WOFF2 fonts the web client loads.

GPUIX registerFont() takes TTF/OTF only, and GPUI picks faces by weight, so
each variable font becomes static instances at the weights Termul uses.
Inter's fontsource subsets are merged back into one face per weight.
Two OpenType features the web client turns on are frozen into the cmap,
because GPUIX cannot set font features per element:
  - Paper Mono `zero` (index.css: `.font-mono { font-variant-numeric: slashed-zero }`)
  - Inter `tnum`, as a separate family for `tabular-nums`

Run from apps/gpuix (needs the repo root node_modules):
  uv run --with fonttools --with brotli python -I tools/style/build-fonts.py
"""

import os
import shutil
import sys
import tempfile

from fontTools.merge import Merger
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


def rename(font, family, weight):
    style = WEIGHTS[weight]
    postscript = f"{family.replace(' ', '')}-{style}"
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
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0b1100001) | (0b100000 if weight == 700 else 0b1000000)
    font["head"].macStyle = 1 if weight == 700 else 0


def save(font, filename):
    path = os.path.join(OUT, filename)
    font.save(path)
    print(f"wrote {os.path.relpath(path, APP)} ({os.path.getsize(path)} bytes)")


def inter(weight, tmp):
    paths = []
    for subset in INTER_SUBSETS:
        static = instance(os.path.join(INTER_DIR, f"inter-{subset}-wght-normal.woff2"), weight)
        path = os.path.join(tmp, f"inter-{subset}-{weight}.ttf")
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


if __name__ == "__main__":
    sys.exit(main())
