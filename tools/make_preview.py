#!/usr/bin/env python3
"""Build a single self-contained preview file from dist/.

The point is something the operator can open straight from his phone with
nothing uploaded anywhere, so:

  * the icons are inlined and the manifest link dropped - one file, no
    siblings to go missing;
  * the service worker registration is removed, because a preview has no
    business installing itself or caching anything;
  * the database is renamed, so tapping around the preview cannot touch the
    real morning draft. This matters whether the file is opened locally or
    parked next to the live app on the same web address, where it would
    otherwise share storage with it;
  * it says PREVIEW at the top, so a test report is never mistaken for the
    real thing.

Run tools/bundle.py first; this reads its output.
"""
import base64
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(ROOT, "preview-of-new-design.html")

BANNER = """
<div style="background:#7a3e00;color:#fff;padding:11px 14px;border-radius:12px;
            margin-bottom:12px;font-size:.85rem;line-height:1.4">
  <strong style="display:block;font-size:.95rem;margin-bottom:3px">PREVIEW &mdash; new design</strong>
  This is a test copy for looking at the new layout. It keeps its own separate
  data, so nothing you type here reaches your real reports, and nothing here is
  sent to anyone. Your normal app is untouched.
</div>
"""


def main():
    index = os.path.join(DIST, "index.html")
    if not os.path.isfile(index):
        raise SystemExit("run tools/bundle.py first - dist/index.html is missing")
    html = open(index, encoding="utf-8").read()

    # 1. icons inlined, manifest dropped
    for size in (192, 512):
        with open(os.path.join(DIST, f"icon-{size}.png"), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        html = html.replace(f'href="icon-{size}.png"',
                            f'href="data:image/png;base64,{b64}"')
    html = html.replace('<link rel="manifest" href="manifest.webmanifest">', '')

    # 2. its own database, so the real draft is out of reach
    html, n = re.subn(r"const DB_NAME = 'opsreport';",
                      "const DB_NAME = 'opsreport-preview';", html, count=1)
    if n != 1:
        raise SystemExit("could not find the database name to rename")

    # 3. no service worker from a preview
    html, n = re.subn(r"navigator\.serviceWorker\.register\('sw\.js'\)",
                      "Promise.reject(new Error('preview: no service worker'))",
                      html, count=1)
    if n != 1:
        raise SystemExit("could not find the service worker registration")

    # 4. unmistakably a preview
    html = html.replace("<title>Daily Ops Report</title>",
                        "<title>PREVIEW - Daily Ops Report</title>")
    html, n = re.subn(r"<main>", "<main>\n" + BANNER, html, count=1)
    if n != 1:
        raise SystemExit("could not find <main> to add the banner to")

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(html)

    leftover = [u for u in re.findall(r'(?:src|href)="(?!data:|#)([^"]+)"', html)
                if not u.startswith("${")]
    print(f"wrote {OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)")
    print(f"files it needs alongside it: {leftover if leftover else 'none'}")
    for must in ["opsreport-preview", "PREVIEW &mdash; new design"]:
        if must not in html:
            print(f"  WARNING: {must!r} missing")
            return 1
    print("checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
