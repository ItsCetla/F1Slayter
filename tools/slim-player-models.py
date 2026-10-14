"""Make the replay player's models lighter to download and to draw.

Run after each update of replays/player from f1-pitwall:

    python3 tools/slim-player-models.py            # rewrites replays/player/{rides,venue}/local/*.glb in place
    python3 tools/slim-player-models.py --check    # exit 1 if any model still carries a PNG or JPEG over 256 KB

Only the pictures inside each .glb change: PNG and JPEG become WebP (EXT_texture_webp, the way Eric's
plant models already are) and none is kept larger than the player can use. The geometry bytes, Draco
and all, are copied untouched, so nothing about a model's shape changes. Running it twice does nothing.
"""
import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

PLAYER = Path(__file__).resolve().parent.parent / "replays" / "player"
FOLDERS = ("rides/local", "venue/local")

# Longest side kept, by file name. A sticker sheet covers a whole car, which is rarely more than half
# the screen wide, so 1024 still reads; at 2048 the eleven sheets alone took ~240 MB of graphics memory.
MAX_SIDE = {"default": 1024, "racer.glb": 1024}
QUALITY = 88            # colour; normal and roughness maps take a little more, see below


def glb_parts(data):
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError("not a glTF 2 binary")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from("<II", data, off)
    return doc, bytearray(data[off + 8:off + 8 + blen])


def glb_join(doc, binary):
    j = json.dumps(doc, separators=(",", ":")).encode()
    j += b" " * (-len(j) % 4)
    binary = bytes(binary) + b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(j) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(j), 0x4E4F534A) + j
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def image_roles(doc):
    """Which images are normal or packed data maps, which want gentler compression than colour."""
    roles = {}
    def mark(tex, role):
        if tex is None:
            return
        t = doc["textures"][tex["index"]]
        src = t.get("source", t.get("extensions", {}).get("EXT_texture_webp", {}).get("source"))
        if src is not None:
            roles.setdefault(src, role)
    for m in doc.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        mark(m.get("normalTexture"), "data")
        mark(pbr.get("metallicRoughnessTexture"), "data")
        mark(m.get("occlusionTexture"), "data")
        mark(pbr.get("baseColorTexture"), "colour")
        mark(m.get("emissiveTexture"), "colour")
    return roles


def to_webp(raw, max_side, role):
    im = Image.open(io.BytesIO(raw))
    im.load()
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.getbands() or im.info.get("transparency") is not None else "RGB")
    if im.mode == "RGBA" and im.getchannel("A").getextrema() == (255, 255):
        im = im.convert("RGB")      # an alpha channel that is all opaque only costs bytes
    if max(im.size) > max_side:
        scale = max_side / max(im.size)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "WEBP", quality=95 if role == "data" else QUALITY, method=6, exact=True)
    return out.getvalue()


def slim(path):
    data = path.read_bytes()
    doc, binary = glb_parts(data)
    images = doc.get("images", [])
    views = doc.get("bufferViews", [])
    roles = image_roles(doc)
    max_side = MAX_SIDE.get(path.name, MAX_SIDE["default"])
    swap = {}
    for i, img in enumerate(images):
        if img.get("mimeType") not in ("image/png", "image/jpeg") or "bufferView" not in img:
            continue
        v = views[img["bufferView"]]
        raw = bytes(binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
        webp = to_webp(raw, max_side, roles.get(i, "colour"))
        if len(webp) >= len(raw) and max(Image.open(io.BytesIO(raw)).size) <= max_side:
            continue                # already as small as it gets: leave this one alone
        swap[img["bufferView"]] = webp
        img["mimeType"] = "image/webp"
    if not swap:
        return len(data), len(data)

    # Lay the buffer out again in bufferView order, every view on a 4-byte boundary as the spec asks.
    out = bytearray()
    for n, v in enumerate(views):
        if v.get("buffer", 0) != 0:
            raise ValueError("more than one buffer")
        piece = swap.get(n)
        if piece is None:
            o = v.get("byteOffset", 0)
            piece = bytes(binary[o:o + v["byteLength"]])
        out += b"\0" * (-len(out) % 4)
        v["byteOffset"] = len(out)
        v["byteLength"] = len(piece)
        out += piece
    doc["buffers"][0]["byteLength"] = len(out)

    webp_images = {i for i, img in enumerate(images) if img.get("mimeType") == "image/webp"}
    for t in doc.get("textures", []):
        if t.get("source") in webp_images:
            t.setdefault("extensions", {})["EXT_texture_webp"] = {"source": t.pop("source")}
    for key in ("extensionsUsed", "extensionsRequired"):
        names = doc.setdefault(key, [])
        if "EXT_texture_webp" not in names:
            names.append("EXT_texture_webp")

    new = glb_join(doc, out)
    tmp = path.with_suffix(".glb.tmp")
    tmp.write_bytes(new)
    tmp.replace(path)               # never leave a half-written model where the player will ask for it
    return len(data), len(new)


def main():
    files = sorted(f for d in FOLDERS for f in (PLAYER / d).glob("*.glb"))
    if "--check" in sys.argv:
        def big_png(f):           # (small ones are left as they are when WebP would not be smaller)
            doc = glb_parts(f.read_bytes())[0]
            return any(i.get("mimeType") in ("image/png", "image/jpeg") and doc["bufferViews"][i["bufferView"]]["byteLength"] > 256_000
                       for i in doc.get("images", []) if "bufferView" in i)
        heavy = [f for f in files if big_png(f)]
        for f in heavy:
            print("still a big PNG/JPEG:", f.relative_to(PLAYER))
        sys.exit(1 if heavy else 0)
    before = after = 0
    for f in files:
        a, b = slim(f)
        before += a
        after += b
        if a != b:
            print(f"{f.relative_to(PLAYER)}: {a / 1e6:.2f} → {b / 1e6:.2f} MB")
    print(f"models: {before / 1e6:.1f} → {after / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
