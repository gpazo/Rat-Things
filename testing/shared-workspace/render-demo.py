"""Edit real native captures. Crops never replace, rearrange or repaint UI content."""
import argparse
import hashlib
import json
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "test-results/shared-workspace-demo"
OUTPUT = ROOT / "artifacts/shared-workspace/demo"
SIZE = (1920, 1080)
FPS = 12
BG, BORDER = "#111112", "#3e3e44"
TEXT, SECONDARY, MUTED = "#f7f8f8", "#d0d6e0", "#8a8f98"
PEOPLE = (("Maya", "Designer", "#d9adf5"), ("Eli", "Engineer", "#8fc9ff"), ("Sam", "QA", "#f3c77b"))


@lru_cache(maxsize=32)
def font(size, weight="Regular"):
    return ImageFont.truetype(str(ROOT / f"desktop/assets/fonts/Inter-{weight}.ttf"), size)


def text(draw, xy, value, size=28, color=TEXT, weight="Regular"):
    draw.text(xy, value, font=font(size, weight), fill=color, spacing=12)


def capture(frame, person, crop):
    with Image.open(SOURCE / f"{frame:05}-{person}.png") as image:
        assert image.size == (1280, 850), "Retune crops if the native viewport changes"
        x0, y0, x1, y1 = crop
        assert 0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height
        return image.convert("RGB").crop(crop)


def paste_capture(board, image, box):
    x, y, width, height = box
    scale = min(width / image.width, height / image.height)
    rendered = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left, top = x + (width - rendered.width) // 2, y + (height - rendered.height) // 2
    board.paste(rendered, (left, top))
    ImageDraw.Draw(board).rectangle((left - 1, top - 1, left + rendered.width, top + rendered.height), outline=BORDER)


def participant(draw, person, xy, suffix="’s view"):
    name, role, color = PEOPLE[person]
    text(draw, xy, name + suffix, 27, color, "Medium")
    text(draw, (xy[0], xy[1] + 41), role, 23, MUTED)


def compose(shot, frame, number, total):
    board = Image.new("RGB", SIZE, BG)
    draw = ImageDraw.Draw(board)
    with Image.open(ROOT / "desktop/assets/brand/glyph-96.png") as mark:
        mark = mark.convert("RGBA").resize((40, 40), Image.Resampling.LANCZOS)
        board.paste(mark, (64, 36), mark)
    text(draw, (116, 41), "Rat Things", 28, weight="SemiBold")
    text(draw, (1402, 45), "Multiplayer shared workspace", 24, MUTED)
    text(draw, (64, 115), shot["title"], 46, weight="SemiBold")
    text(draw, (64, 184), shot["subtitle"], 27, SECONDARY)
    layout = shot["layout"]

    if layout == "opening":
        text(draw, (64, 314), "The brief", 24, MUTED, "Medium")
        text(draw, (64, 364), "From “works on my machine”\nto “we can reproduce it together.”", 34, weight="Medium")
        text(draw, (64, 500), "One page to review.\nOne place for everyone’s feedback.", 27, SECONDARY)
        for person in range(3):
            participant(draw, person, (64 + person * 225, 700), "")
        text(draw, (64, 850), "Real local clients and browser.\nDemo identities and scripted agent replies.", 24, MUTED)
        paste_capture(board, capture(frame, 1, shot["crop"]), (850, 280, 1006, 640))
        text(draw, (850, 936), "Concept page under review", 24, MUTED)
    elif layout == "rows":
        for person in range(3):
            top = 293 + person * 218
            participant(draw, person, (88, top + 42))
            paste_capture(board, capture(frame, person, shot["crop"]), (438, top, 1390, 190))
    elif layout == "agent":
        text(draw, (64, 295), "Actual conversation excerpt · scripted agent reply", 24, MUTED)
        paste_capture(board, capture(frame, 2, shot["crop"]), (64, 362, 1792, 215))
        labels = (("Captured image", "The exact version reviewed"), ("Team feedback", "Each comment keeps its author"), ("Same agent", "One continuing conversation"))
        for index, (label, detail) in enumerate(labels):
            x = 88 + index * 600
            text(draw, (x, 715), label, 32, weight="Medium")
            text(draw, (x, 770), detail, 23, SECONDARY)
            if index < 2:
                text(draw, (x + 480, 729), "→", 34, MUTED)
        text(draw, (88, 899), "The reply demonstrates the feedback flow; it is not live model reasoning.", 25, MUTED)
    else:
        person = shot["person"]
        name, role, color = PEOPLE[person]
        text(draw, (64, 250), f"{name} · {role}  /  native console", 24, color, "Medium")
        paste_capture(board, capture(frame, person, shot["crop"]), (64, 303, 1792, 650))

    text(draw, (64, 1019), "Local capture · Scripted agent replies · Edited timing · No audio", 23, MUTED)
    text(draw, (1734, 1019), f"{number:02} / {total:02}", 23, MUTED)
    draw.line((64, 990, 1856, 990), fill=BORDER)
    draw.line((64, 990, 64 + 1792 * number / total, 990), fill="#828fff", width=2)
    return board


def samples(shot, metadata):
    """Map an edited shot to existing captures; no interpolated or invented states."""
    first, last = shot["frames"]
    count = round(shot["seconds"] * FPS)
    hold = round(shot.get("hold_seconds", 1) * FPS)
    elapsed = [metadata[index]["elapsed_ms"] for index in range(first, last + 1)]
    result = []
    for index in range(count):
        fraction = min(1, index / max(1, count - hold - 1))
        at = elapsed[0] + fraction * (elapsed[-1] - elapsed[0])
        result.append(first + max(i for i, value in enumerate(elapsed) if value <= at))
    return result


def srt_time(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02},{milliseconds % 1000:03}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true", help="Render a review image per shot without encoding video")
    args = parser.parse_args()
    edit = json.loads((ROOT / "testing/shared-workspace/share-edit.json").read_text())
    manifest = (SOURCE / "frames.json").read_bytes()
    assert hashlib.sha256(manifest).hexdigest() == edit["source_manifest_sha256"], "Capture changed: review and retime share-edit.json first"
    metadata = json.loads(manifest)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    review = OUTPUT / "review"
    review.mkdir(exist_ok=True)
    shots, timeline, subtitles, used = edit["shots"], [], [], set()
    elapsed = 0
    process = None
    if not args.preview:
        process = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1920x1080", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUTPUT / "multiplayer-workspace.mp4")], stdin=subprocess.PIPE)
    try:
        for index, shot in enumerate(shots, 1):
            selected = samples(shot, metadata)
            cache_frame, raw = None, None
            preview = compose(shot, selected[-1], index, len(shots))
            preview.save(review / f"{index:02}-{shot['id']}.jpg", quality=94)
            if shot["id"] == "maya-pin":
                preview.save(OUTPUT / "poster.png")
            for frame in set(selected):
                for person in range(3) if shot["layout"] == "rows" else [shot.get("person", 1 if shot["layout"] == "opening" else 2)]:
                    used.add(f"{frame:05}-{person}.png")
            if process:
                for frame in selected:
                    if frame != cache_frame:
                        raw = compose(shot, frame, index, len(shots)).tobytes()
                        cache_frame = frame
                    process.stdin.write(raw)
            end = elapsed + len(selected) / FPS
            timeline.append({**shot, "start_seconds": elapsed, "end_seconds": end, "used_frames": sorted(set(selected))})
            subtitles.append(f"{index}\n{srt_time(elapsed)} --> {srt_time(end)}\n{shot['title']}\n{shot['subtitle']}\n")
            elapsed = end
    finally:
        if process:
            process.stdin.close()
            assert process.wait() == 0, "Video encoder failed"
    contact = Image.new("RGB", (1440, ((len(shots) + 1) // 2) * 430), BG)
    for index, shot in enumerate(shots):
        with Image.open(review / f"{index + 1:02}-{shot['id']}.jpg") as image:
            contact.paste(image.resize((720, 405), Image.Resampling.LANCZOS), ((index % 2) * 720, (index // 2) * 430))
    contact.save(review / "storyboard.jpg", quality=92)
    if args.preview:
        print(f"Review images: {review}")
        return
    (OUTPUT / "multiplayer-workspace.srt").write_text("\n".join(subtitles))
    recording = {"source": "Actual ConsoleApp renders driven through native controls", "source_manifest_sha256": edit["source_manifest_sha256"], "fps": FPS, "duration_seconds": elapsed, "frames": round(elapsed * FPS), "model": "Deterministic local Responses fixture; no paid inference", "identity": "Three fixture identities on authenticated loopback connections; not OIDC login validation", "editing": "Crops, cuts and holds only. No UI text replaced. Resolve/reopen omitted; final excerpt crops the first of the fixture's repeated replies.", "timing": "Presentation timing is edited, not a latency measurement", "timeline": timeline, "source_images": {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in sorted(used)}}
    (OUTPUT / "recording.json").write_text(json.dumps(recording, indent=2) + "\n")
    print(f"Saved {OUTPUT / 'multiplayer-workspace.mp4'} ({elapsed:.1f}s)")


if __name__ == "__main__":
    main()
