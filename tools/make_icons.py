#!/usr/bin/env python3
"""Generate the app launcher icons with no third-party image libraries.

Writes a full-bleed navy tile with three white 'checked line' rows, which
reads clearly at small sizes and survives Android's maskable icon crop.
"""
import os
import struct
import zlib

NAVY = (30, 58, 95)
WHITE = (255, 255, 255)
GREEN = (111, 211, 155)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "www", "icons")


def blank(size, colour):
    return [[colour for _ in range(size)] for _ in range(size)]


def fill_rect(px, x0, y0, x1, y1, colour):
    size = len(px)
    for y in range(max(0, int(y0)), min(size, int(y1))):
        row = px[y]
        for x in range(max(0, int(x0)), min(size, int(x1))):
            row[x] = colour


def thick_line(px, x0, y0, x1, y1, width, colour):
    """Draw a line by stamping a filled square along it."""
    size = len(px)
    steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
    half = width / 2.0
    for i in range(steps + 1):
        t = i / steps
        cx = x0 + (x1 - x0) * t
        cy = y0 + (y1 - y0) * t
        for y in range(int(cy - half), int(cy + half) + 1):
            if y < 0 or y >= size:
                continue
            row = px[y]
            for x in range(int(cx - half), int(cx + half) + 1):
                if 0 <= x < size:
                    row[x] = colour


def draw_icon(size):
    px = blank(size, NAVY)
    u = size / 24.0  # design grid unit

    rows = 3
    top = 6.0 * u
    gap = 4.6 * u
    tick_x = 5.0 * u
    bar_x0 = 10.4 * u
    bar_x1 = 19.0 * u
    bar_h = max(1, round(1.5 * u))
    stroke = max(1, round(1.35 * u))

    for r in range(rows):
        cy = top + r * gap
        colour = GREEN if r == 0 else WHITE
        # check mark: short down-stroke then long up-stroke
        thick_line(px, tick_x - 1.5 * u, cy, tick_x - 0.3 * u, cy + 1.25 * u, stroke, colour)
        thick_line(px, tick_x - 0.3 * u, cy + 1.25 * u, tick_x + 1.9 * u, cy - 1.5 * u, stroke, colour)
        # value bar
        fill_rect(px, bar_x0, cy - bar_h / 2.0, bar_x1, cy - bar_h / 2.0 + bar_h, WHITE)

    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)  # filter type 0
        for (r, g, b) in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (192, 512):
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        write_png(path, draw_icon(size))
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
