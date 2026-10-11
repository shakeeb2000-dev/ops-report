#!/usr/bin/env python3
"""Flatten www/ into dist/ for easy upload from a phone.

The CSS and all four scripts are inlined into a single index.html, and the
icons move out of their subfolder, so the whole app becomes five files sitting
in one directory with no nesting to navigate on a mobile file picker.
"""
import hashlib
import os
import re
import shutil

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "www")
OUT = os.path.join(ROOT, "dist")

SCRIPTS = ["config.js", "pdf.js", "report.js", "app.js"]


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as fh:
        return fh.read()


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # Build id comes from the sources, not the output, so stamping it into the
    # page cannot change it.
    fingerprint = hashlib.sha256()
    for name in ["index.html", "styles.css"] + SCRIPTS:
        fingerprint.update(read(name).encode("utf-8"))
    build_id = fingerprint.hexdigest()[:12]

    html = read("index.html")

    # 1. inline the stylesheet
    css = read("styles.css")
    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        "<style>\n" + css + "\n</style>",
    )

    # 2. inline the scripts, in their original order
    bundle_parts = []
    for name in SCRIPTS:
        bundle_parts.append(f"/* ===== {name} ===== */\n" + read(name))
    bundle = "\n\n".join(bundle_parts)

    for name in SCRIPTS:
        html = html.replace(f'<script src="{name}"></script>', "", 1)
    html = html.replace("</body>", "<script>\n" + bundle + "\n</script>\n</body>")

    # 3. icons lose their subfolder
    html = html.replace('href="icons/icon-192.png"', 'href="icon-192.png"')

    # 4. stamp the version so the app can show which build is installed
    html = html.replace("__BUILD_ID__", build_id)

    # tidy the blank lines left by the removed script tags
    html = re.sub(r"\n{3,}", "\n\n", html)

    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)

    # 4. manifest, with flattened icon paths
    manifest = read("manifest.webmanifest").replace("icons/icon-", "icon-")
    with open(os.path.join(OUT, "manifest.webmanifest"), "w", encoding="utf-8") as fh:
        fh.write(manifest)

    # 5. service worker caching the flattened file list.
    #    The cache name embeds a hash of the built app, so publishing a new
    #    index.html automatically invalidates the old offline copy. Without
    #    this the phone would keep serving the previous version forever.
    # The worker itself is NOT duplicated here. It used to be, and the two
    # copies drifted: a fix made in www/sw.js never reached the build that
    # actually ships. Only the two lines that differ are rewritten - the cache
    # name, which embeds the build id so a new upload replaces the old offline
    # copy, and the flattened asset list.
    sw_src = open(os.path.join(SRC, "sw.js"), encoding="utf-8").read()
    sw, n_cache = re.subn(
        r"const CACHE = '[^']*';",
        "const CACHE = 'ops-report-%s';" % build_id,
        sw_src,
        count=1,
    )
    sw, n_assets = re.subn(
        r"const ASSETS = \[[^\]]*\];",
        "const ASSETS = ['./', 'index.html', 'manifest.webmanifest', "
        "'icon-192.png', 'icon-512.png'];",
        sw,
        count=1,
    )
    if n_cache != 1 or n_assets != 1:
        raise SystemExit(
            "bundle.py could not find the CACHE and ASSETS lines in www/sw.js "
            "- check they are still single-line const declarations"
        )

    with open(os.path.join(OUT, "sw.js"), "w", encoding="utf-8") as fh:
        fh.write(sw)

    # 6. icons
    for size in (192, 512):
        shutil.copy(
            os.path.join(SRC, "icons", f"icon-{size}.png"),
            os.path.join(OUT, f"icon-{size}.png"),
        )

    print(f"dist/ written to {os.path.abspath(OUT)}\n")
    total = 0
    for name in sorted(os.listdir(OUT)):
        size = os.path.getsize(os.path.join(OUT, name))
        total += size
        print(f"  {name:26} {size/1024:7.1f} KB")
    print(f"  {'TOTAL':26} {total/1024:7.1f} KB")

    # sanity checks
    out_html = open(os.path.join(OUT, "index.html"), encoding="utf-8").read()
    problems = []
    if 'src="config.js"' in out_html or 'href="styles.css"' in out_html:
        problems.append("external references remain in index.html")
    for marker in ["CHECKLIST", "class PdfDoc", "function buildPdf", "function boot"]:
        if marker not in out_html:
            problems.append(f"missing {marker!r} in the bundle")
    if "icons/" in out_html:
        problems.append("a nested icons/ path survived")
    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print("  -", p)
        raise SystemExit(1)
    print("\nBundle checks passed.")


if __name__ == "__main__":
    main()
