#!/usr/bin/env python3
"""Génère les icônes (PWA + launcher Android) sans dépendance externe.
Dessine un éclair ⚡ vert sur fond sombre arrondi. Encodeur PNG pur-Python."""
import struct, zlib, math, os, sys

BG = (11, 18, 32)        # #0b1220
G1 = (34, 197, 94)       # vert
G2 = (163, 255, 196)     # vert clair (dégradé)

# Éclair normalisé (0..1), y vers le bas.
BOLT = [(0.52, 0.06), (0.26, 0.54), (0.45, 0.54), (0.40, 0.94),
        (0.74, 0.40), (0.54, 0.40), (0.60, 0.06)]

def in_poly(px, py, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and \
           (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def make(size):
    s = size
    rad = s * 0.22
    poly = [(x * s, y * s) for (x, y) in BOLT]
    px = bytearray()
    for y in range(s):
        px.append(0)  # filtre 0
        for x in range(s):
            cx = min(max(x, rad), s - rad); cy = min(max(y, rad), s - rad)
            if math.hypot(x - cx, y - cy) > rad:
                px += bytes((0, 0, 0, 0)); continue
            if in_poly(x + 0.5, y + 0.5, poly):
                f = y / s
                col = tuple(int(G1[i] + (G2[i] - G1[i]) * f) for i in range(3))
                px += bytes((col[0], col[1], col[2], 255))
            else:
                px += bytes((BG[0], BG[1], BG[2], 255))
    return png(s, s, bytes(px))

def png(w, h, raw):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

def write(path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f: f.write(make(size))
    print("écrit", path, size)

if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    write(os.path.join(base, "www/img/icon-192.png"), 192)
    write(os.path.join(base, "www/img/icon-512.png"), 512)
    if "--android" in sys.argv:
        dens = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
        for d, sz in dens.items():
            for name in ("ic_launcher", "ic_launcher_round", "ic_launcher_foreground"):
                write(os.path.join(base, f"android/app/src/main/res/mipmap-{d}/{name}.png"), sz)
