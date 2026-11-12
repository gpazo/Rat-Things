"""Cut the live Claude + Codex recording into a short 1080p video.

Every UI pixel comes from native renders in test-results/agents-live/. The edit only
crops, scales, holds and speeds up frames; it adds one headline per beat and an end card.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "test-results/agents-live"
OUTPUT = ROOT / "artifacts/shared-workspace/agents-live"
FONTS = ROOT / "desktop/assets/fonts"
W, H, BAND, FPS = 1920, 1080, 110, 30
BG_DEEP, BG, TEXT, SECONDARY, MUTED = "#111112", "#181819", "#f7f8f8", "#d0d6e0", "#8a8f98"
semibold = ImageFont.truetype(str(FONTS / "Inter-SemiBold.ttf"), 44)
large = ImageFont.truetype(str(FONTS / "Inter-SemiBold.ttf"), 76)
regular = ImageFont.truetype(str(FONTS / "Inter-Regular.ttf"), 26)
small = ImageFont.truetype(str(FONTS / "Inter-Regular.ttf"), 22)

# Conversation crops follow the message column of the 2560x1600 render; TYPING frames the composer.
CONVERSATION = (640, 741, 2340, 1600)
TOP = (640, 0, 2340, 859)
TYPING = (680, 1080, 1720, 1606)
PANEL = (460, 380, 2560, 1441)
BROWSER = (500, 540, 1720, 1160)

# (headline, participant window, frame range, crop or (crop_start, crop_end), seconds)
BEATS = [
    ("Codex's window: Claude is typing", "codex", (1, 1), (TYPING, CONVERSATION), 3.5),
    ("Claude's brief lands, signed by name", "codex", (2, 2), TOP, 5.0),
    ("One shared agent works on it, live", "codex", (3, 90), CONVERSATION, 6.0),
    ("Claude's window: Codex joins", "claude", (91, 91), (TYPING, CONVERSATION), 3.5),
    ("Codex asks for proof, not mockups", "claude", (93, 93), CONVERSATION, 6.0),
    ("The shared agent applies it", "claude", (94, 119), CONVERSATION, 4.0),
    ("Claude replies to Codex", "codex", (120, 120), CONVERSATION, 3.0),
    ("…and adds an honesty rule", "codex", (122, 122), CONVERSATION, 5.5),
    ("Plan locked", "codex", (123, 151), CONVERSATION, 4.0),
    ("The storyboard, in the shared live browser", "codex", (175, 175), (PANEL, BROWSER), 7.0),
]
END_SECONDS = 9.0


def frame_file(index: int, who: str) -> Path:
    """Use the latest capture of this participant at or before the index."""
    for candidate in range(index, -1, -1):
        path = SOURCE / f"{candidate:05d}-{who}.png"
        if path.exists():
            return path
    raise FileNotFoundError(f"No capture for {who} at {index}")


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def compose(image: Image.Image, crop, headline: str) -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG_DEEP)
    area = (W, H - BAND)
    view = image.crop(crop)
    scale = min(area[0] / view.width, area[1] / view.height)
    view = view.resize((round(view.width * scale), round(view.height * scale)), Image.LANCZOS)
    canvas.paste(view, ((W - view.width) // 2, BAND + (area[1] - view.height) // 2))
    ImageDraw.Draw(canvas).text((72, BAND // 2), headline, font=semibold, fill=TEXT, anchor="lm")
    return canvas


def end_card(model: str) -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    mark = Image.open(ROOT / "assets/brand/rat-things-mark-1024.png").convert("RGBA").resize((120, 120), Image.LANCZOS)
    canvas.paste(mark, (W // 2 - 60, 250), mark)
    draw.text((W // 2, 470), "Two agents. One local Session.", font=large, fill=TEXT, anchor="mm")
    draw.text((W // 2, 560), "Claude Code and Codex CLI, planning together in Rat Things on one Mac.", font=regular, fill=SECONDARY, anchor="mm")
    fine = [
        f"Real: one local Rat Things Session, live {model} replies via ChatGPT subscription, native console renders.",
        "Demo-only: participant identities are loopback tokens (no sign-in). About 15 minutes cut to under a minute.",
    ]
    for offset, line in enumerate(fine):
        draw.text((W // 2, 930 + offset * 36), line, font=small, fill=MUTED, anchor="mm")
    return canvas


def main() -> None:
    preview = "--preview" in sys.argv
    model = json.loads((OUTPUT / "cleanup.json").read_text())["model"] if (OUTPUT / "cleanup.json").exists() else "gpt-5.6-luna"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="agents-live-render-"))
    count = 0
    try:
        for headline, who, (first, last), crop, seconds in BEATS:
            total = round(seconds * FPS)
            for step in range(total):
                t = step / max(total - 1, 1)
                index = round(first + (last - first) * min(t / 0.85, 1.0))  # Sequences settle before the cut.
                box = lerp(crop[0], crop[1], ease(min(max((t - 0.25) / 0.5, 0), 1))) if isinstance(crop[0], tuple) else crop
                compose(Image.open(frame_file(index, who)).convert("RGB"), box, headline).save(work / f"{count:05d}.jpg", quality=92)
                count += 1
            if preview:
                shutil.copy(work / f"{count - 1:05d}.jpg", OUTPUT / f"preview-{len(list(OUTPUT.glob('preview-*')))}.jpg")
        card = end_card(model)
        card.save(OUTPUT / "end-card.png")
        for _ in range(round(END_SECONDS * FPS)):
            card.save(work / f"{count:05d}.jpg", quality=92)
            count += 1
        if preview:
            return
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", str(work / "%05d.jpg"),
                        "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart",
                        str(OUTPUT / "claude-codex-multiplayer.mp4")], check=True)
        shutil.copy(work / f"{round(sum(beat[4] for beat in BEATS[:5]) * FPS):05d}.jpg", OUTPUT / "poster.jpg")
    finally:
        shutil.rmtree(work)
    print(f"{count / FPS:.1f}s → {OUTPUT / 'claude-codex-multiplayer.mp4'}")


if __name__ == "__main__":
    main()
