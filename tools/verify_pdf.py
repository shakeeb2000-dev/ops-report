#!/usr/bin/env python3
"""Structurally validate a PDF produced by www/pdf.js.

There is no PDF tooling available in this environment, so this checks the
things a reader would reject on: xref offsets, object numbering, stream
/Length accuracy, page tree consistency, resolvable resource references,
and byte-exact survival of embedded JPEGs.

Usage: python3 tools/verify_pdf.py report.pdf [photo.jpg ...]
"""
import re
import sys

FAIL = []
WARN = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        FAIL.append(msg)
        print(f"  FAIL {msg}")


def main(path, photo_paths):
    data = open(path, "rb").read()
    print(f"\n{path}: {len(data)} bytes")

    print("\nHeader and trailer")
    check(data.startswith(b"%PDF-1."), "starts with a %PDF- header")
    check(data.rstrip().endswith(b"%%EOF"), "ends with %%EOF")

    m = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data)
    check(m is not None, "startxref present at end of file")
    if not m:
        return summarise()
    xref_start = int(m.group(1))
    check(data[xref_start:xref_start + 4] == b"xref", "startxref points at the xref keyword")

    # ---- parse the xref table ----
    print("\nCross-reference table")
    tail = data[xref_start:]
    hm = re.match(rb"xref\s+(\d+)\s+(\d+)\s+", tail)
    check(hm is not None, "xref subsection header parses")
    if not hm:
        return summarise()
    first, count = int(hm.group(1)), int(hm.group(2))
    check(first == 0, "xref starts at object 0")

    entry_re = re.compile(rb"(\d{10}) (\d{5}) ([nf])")
    entries = entry_re.findall(tail[hm.end():hm.end() + count * 20 + 40])
    check(len(entries) >= count, f"xref lists {count} entries (found {len(entries)})")
    entries = entries[:count]
    check(entries[0][2] == b"f", "object 0 is the free entry")

    # ---- every in-use entry must land exactly on "N 0 obj" ----
    bad_offsets = []
    for num, (off, _gen, kind) in enumerate(entries):
        if kind != b"n":
            continue
        offset = int(off)
        expect = f"{num} 0 obj".encode()
        if data[offset:offset + len(expect)] != expect:
            bad_offsets.append((num, offset, data[offset:offset + 20]))
    check(not bad_offsets, "every xref offset lands on its object header")
    for num, offset, got in bad_offsets[:5]:
        print(f"       object {num}: offset {offset} -> {got!r}")

    # ---- trailer ----
    print("\nTrailer")
    tm = re.search(rb"trailer\s*<<(.+?)>>\s*startxref", data, re.S)
    check(tm is not None, "trailer dictionary present")
    if tm:
        trailer = tm.group(1)
        size = re.search(rb"/Size\s+(\d+)", trailer)
        root = re.search(rb"/Root\s+(\d+)\s+0\s+R", trailer)
        check(size is not None and int(size.group(1)) == count,
              f"/Size matches the xref entry count ({count})")
        check(root is not None, "/Root reference present")

    # ---- objects ----
    print("\nObjects")
    objs = {}
    for om in re.finditer(rb"(\d+) 0 obj\b", data):
        objs[int(om.group(1))] = om.start()
    in_use = [n for n, e in enumerate(entries) if e[2] == b"n"]
    check(set(objs) == set(in_use),
          f"objects on disk match the xref ({len(objs)} found, {len(in_use)} expected)")

    endobj_count = len(re.findall(rb"\bendobj\b", data))
    check(endobj_count == len(objs), f"every object is closed with endobj ({endobj_count})")

    # ---- stream lengths ----
    print("\nStream lengths")
    mismatches = []
    stream_count = 0
    for sm in re.finditer(rb"/Length (\d+)\s*>>\s*stream\r?\n", data):
        stream_count += 1
        declared = int(sm.group(1))
        body_start = sm.end()
        end = data.find(b"endstream", body_start)
        actual_region = data[body_start:end]
        # writer emits "endstream" straight after the bytes, or after one \n
        actual = len(actual_region)
        if actual != declared and actual - 1 != declared:
            mismatches.append((declared, actual))
    check(stream_count > 0, f"found {stream_count} streams")
    check(not mismatches, "every /Length matches the real stream size")
    for d, a in mismatches[:5]:
        print(f"       declared {d}, actual {a}")

    # ---- page tree ----
    print("\nPage tree")
    pm = re.search(rb"/Type\s*/Pages\s*/Kids\s*\[(.*?)\]\s*/Count\s+(\d+)", data, re.S)
    check(pm is not None, "page tree node present")
    if pm:
        kids = re.findall(rb"(\d+)\s+0\s+R", pm.group(1))
        declared = int(pm.group(2))
        check(len(kids) == declared, f"/Count ({declared}) matches Kids length ({len(kids)})")
        page_objs = len(re.findall(rb"/Type\s*/Page[^s]", data))
        check(page_objs == declared, f"{declared} page objects exist")
        missing = [k for k in kids if int(k) not in objs]
        check(not missing, "every Kid reference resolves to a real object")

    # ---- resources resolve ----
    print("\nResources")
    refs = set()
    for rm in re.finditer(rb"/(?:F1|F2|Im\d+)\s+(\d+)\s+0\s+R", data):
        refs.add(int(rm.group(1)))
    check(refs and all(r in objs for r in refs),
          f"all {len(refs)} font/image references resolve")

    fonts = re.findall(rb"/BaseFont\s*/([A-Za-z-]+)", data)
    check(b"Helvetica" in fonts and b"Helvetica-Bold" in fonts,
          f"base-14 fonts declared ({[f.decode() for f in set(fonts)]})")
    check(len(re.findall(rb"/WinAnsiEncoding", data)) >= 2,
          "fonts declare WinAnsiEncoding")

    # ---- images ----
    print("\nImages")
    img_objs = re.findall(rb"/Subtype\s*/Image", data)
    print(f"  info {len(img_objs)} image XObject(s)")
    if img_objs:
        check(len(re.findall(rb"/Filter\s*/DCTDecode", data)) == len(img_objs),
              "every image uses /DCTDecode")
        check(len(re.findall(rb"/ColorSpace\s*/DeviceRGB", data)) == len(img_objs),
              "every image declares /DeviceRGB")
        soi = data.count(b"\xFF\xD8\xFF")
        check(soi >= len(img_objs), f"JPEG start markers present ({soi})")

    for p in photo_paths:
        raw = open(p, "rb").read()
        check(raw in data, f"{p} embedded byte-for-byte ({len(raw)} bytes)")

    # ---- text content sanity ----
    print("\nContent")
    check(b"BT" in data and b"ET" in data, "text blocks present")
    check(data.count(b" re f") > 5, "filled rectangles present (tables/pills)")
    high = re.findall(rb"\\([0-7]{3})", data)
    check(True, f"octal-escaped high bytes used {len(high)} time(s)")
    # No raw non-ASCII should leak into a content stream literal
    check(b"\xe2\x9c\x85" not in data, "no raw UTF-8 emoji leaked into the PDF")

    return summarise()


def summarise():
    print("\n" + "=" * 46)
    if FAIL:
        print(f"FAILED {len(FAIL)} check(s):")
        for f in FAIL:
            print(f"  - {f}")
        return 1
    print("All structural checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
