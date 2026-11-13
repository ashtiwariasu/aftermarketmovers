#!/usr/bin/env python3
"""Avatar V base + returned subtitle timings → locally branded AMM Short.

HeyGen owns only the continuous presenter performance. The locked package owns
every spoken word, and the locally generated cards own every research visual.
"""

import difflib
import hashlib
import html
import json
import os
import re
import subprocess
import sys

LEGACY_BEAT_ORDER = ("hook", "change", "thesis", "evidence", "council", "close")
LOCKED_WEEKDAY_BEAT_ORDER = (
    "hook", "change", "evidence", "thesis", "council", "close",
)
LOCKED_WEEKDAY_TEMPLATE = "amm-weekday-locked-v3"
LOCKED_WEEKDAY_DELIVERY_TOLERANCE_SECONDS = 2.0


def beat_order(package: dict) -> tuple[str, ...]:
    if package.get("editorial", {}).get("templateVersion") == LOCKED_WEEKDAY_TEMPLATE:
        return LOCKED_WEEKDAY_BEAT_ORDER
    return LEGACY_BEAT_ORDER


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result.stdout + result.stderr


def duration(path: str) -> float:
    return float(run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ]).strip())


def seconds(value: str) -> float:
    hours, minutes, rest = value.replace(".", ",").split(":")
    sec, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(sec) + int(millis) / 1000


def tokens(value: str) -> list[str]:
    clean = html.unescape(re.sub(r"<[^>]+>", " ", value)).lower()
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", clean)


def parse_srt(path: str) -> list[dict]:
    blocks = re.split(r"\n\s*\n", open(path, encoding="utf-8-sig").read().strip())
    cues = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing = next((line for line in lines if "-->" in line), None)
        if not timing:
            continue
        timing_index = lines.index(timing)
        start, end = [part.strip().split(" ")[0] for part in timing.split("-->")]
        text = " ".join(lines[timing_index + 1:])
        cue_tokens = tokens(text)
        if cue_tokens:
            cues.append({
                "start": seconds(start),
                "end": seconds(end),
                "text": text,
                "tokens": cue_tokens,
            })
    if not cues:
        raise ValueError("HeyGen subtitle file contains no timed speech")
    return cues


def derive_beat_timings(package: dict, cues: list[dict]) -> tuple[dict, float]:
    expected, ranges = [], {}
    for name in beat_order(package):
        start = len(expected)
        expected.extend(tokens(package["editorial"]["beats"][name]["text"]))
        ranges[name] = (start, len(expected))

    observed, observed_times = [], []
    for cue in cues:
        count = len(cue["tokens"])
        span = max(0.01, cue["end"] - cue["start"])
        for index, token in enumerate(cue["tokens"]):
            observed.append(token)
            observed_times.append((
                cue["start"] + span * index / count,
                cue["start"] + span * (index + 1) / count,
            ))

    matcher = difflib.SequenceMatcher(a=expected, b=observed, autojunk=False)
    ratio = matcher.ratio()
    if ratio < 0.90:
        raise ValueError(
            f"subtitle/script match is only {ratio:.1%}; refusing approximate card timing")

    expected_to_observed = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            expected_to_observed[block.a + offset] = block.b + offset

    def observed_index(expected_index: int) -> int:
        if expected_index in expected_to_observed:
            return expected_to_observed[expected_index]
        candidates = sorted(
            expected_to_observed,
            key=lambda candidate: abs(candidate - expected_index),
        )
        if not candidates:
            raise ValueError("subtitle matcher found no aligned words")
        candidate = candidates[0]
        estimate = expected_to_observed[candidate] + (expected_index - candidate)
        return max(0, min(len(observed_times) - 1, estimate))

    timings = {}
    for name, (first, after_last) in ranges.items():
        first_observed = observed_index(first)
        last_observed = observed_index(after_last - 1)
        timings[name] = {
            "start": round(observed_times[first_observed][0], 3),
            "end": round(observed_times[last_observed][1], 3),
        }
    return timings, ratio


def derive_display_timings(
    timings: dict,
    total: float,
    order: tuple[str, ...] = LEGACY_BEAT_ORDER,
) -> dict:
    """Keep one research visual on screen for the entire presenter performance."""
    display = {}
    for index, name in enumerate(order):
        next_name = order[index + 1] if index + 1 < len(order) else None
        display[name] = {
            "start": 0.0 if index == 0 else timings[name]["start"],
            "end": timings[next_name]["start"] if next_name else total + 0.2,
        }
    return display


def measured_loudnorm(path: str, speed: float) -> dict:
    command = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", path,
        "-af", (
            f"atempo={speed:.8f},"
            # Leave enough headroom for AAC inter-sample overshoot. A -1 dBTP
            # source target encoded at 192 kbps measured as high as -0.3 dBTP.
            "loudnorm=I=-14:TP=-2:LRA=11:print_format=json"
        ),
        "-f", "null", "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    blocks = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", result.stderr + result.stdout)
    if not blocks:
        raise ValueError("ffmpeg returned no loudness measurement")
    return json.loads(blocks[-1])


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(
    base: str,
    subtitles: str,
    cards_dir: str,
    package_path: str,
    out_path: str,
) -> None:
    package = json.load(open(package_path))
    if package.get("schema") != "amm-short-episode-v1":
        sys.exit("finish accepts only a validated amm-short-episode-v1 package")

    total = duration(base)
    cues = parse_srt(subtitles)
    timings, transcript_match = derive_beat_timings(package, cues)
    order = beat_order(package)
    display_timings = derive_display_timings(timings, total, order)
    card = lambda name: os.path.join(cards_dir, name)
    locked_weekday = (
        package.get("editorial", {}).get("templateVersion")
        == LOCKED_WEEKDAY_TEMPLATE
    )
    if locked_weekday:
        layout = LOCKED_WEEKDAY_TEMPLATE
        plan_path = card("weekday-visual-plan.json")
        if not os.path.isfile(plan_path):
            sys.exit("locked weekday visual plan is missing")
        plan = json.load(open(plan_path))
        if plan.get("templateVersion") != LOCKED_WEEKDAY_TEMPLATE:
            sys.exit("locked weekday visual plan has the wrong template version")
        expected_scenes = [
            {"beat": name, "file": f"weekday-{index:02d}-{name}.png"}
            for index, name in enumerate(order, start=1)
        ]
        actual_scenes = [
            {"beat": scene.get("beat"), "file": scene.get("file")}
            for scene in plan.get("scenes", [])
        ]
        if actual_scenes != expected_scenes:
            sys.exit("locked weekday visual scene order drifted")
        overlays = [
            (
                card(scene["file"]),
                display_timings[scene["beat"]]["start"],
                display_timings[scene["beat"]]["end"],
            )
            for scene in expected_scenes
        ]
        missing = [png for png, _, _ in overlays if not os.path.isfile(png)]
        if missing:
            sys.exit("locked weekday scene assets are missing: " + ", ".join(missing))
        # Preserve the full face from portrait photo-avatar renders. A softened
        # full-width copy fills the wings while the undistorted presenter stays
        # prominent in the centre; the lower panel remains the larger surface.
        chain = [
            "[0:v]split=2[portraitbg][portraitfg]",
            "[portraitbg]crop=1080:1010:0:210,scale=1000:700:flags=lanczos,"
            "gblur=sigma=22[softbg]",
            "[portraitfg]crop=1080:1010:0:210,scale=748:700:flags=lanczos[person]",
            "[softbg][person]overlay=126:0[portrait]",
            "[portrait]pad=1080:1920:40:116:color=0xF4F1EA[framed]",
        ]
        previous = "framed"
        inputs = []
        render_items = overlays
    else:
        layout = os.environ.get("AMM_SHORT_LAYOUT", "split").strip().lower()
        if layout not in {"split", "full"}:
            sys.exit("AMM_SHORT_LAYOUT must be split or full")
        prefix = "split-" if layout == "split" else "s-"
        overlays = [
            (card(f"{prefix}hook.png"), display_timings["change"]["start"], display_timings["change"]["end"]),
            (card(f"{prefix}meter.png"), display_timings["thesis"]["start"], display_timings["thesis"]["end"]),
            (card(f"{prefix}vote.png"), display_timings["council"]["start"], display_timings["council"]["end"]),
            (card(f"{prefix}end.png"), display_timings["close"]["start"], display_timings["close"]["end"]),
        ]
        caption_meta = json.load(open(card("caption-weights.json")))
        weights = caption_meta["weights"]
        if not weights:
            sys.exit("no evidence captions were generated")
        cap_prefix = "split-cap" if layout == "split" else "cap"
        captions = [
            (card(f"{cap_prefix}1.png"), display_timings["hook"]["start"], display_timings["hook"]["end"]),
        ]
        evidence_start = display_timings["evidence"]["start"]
        evidence_span = display_timings["evidence"]["end"] - evidence_start
        cursor = evidence_start
        for index, weight in enumerate(weights):
            caption_duration = evidence_span * weight / sum(weights)
            captions.append((
                card(f"{cap_prefix}{index + 2}.png"),
                cursor,
                cursor + caption_duration,
            ))
            cursor += caption_duration
        if layout == "split":
            chain = [
                "[0:v]crop=1080:1120:0:0,scale=1000:1037:flags=lanczos,"
                "pad=1080:1920:40:116:color=0xF4F1EA[paperbase]",
                "[paperbase][1:v]overlay=0:0[framed]",
            ]
            frame_name = "split-frame.png"
        else:
            chain = [
                "[0:v]scale=972:1728:flags=lanczos,"
                "pad=1080:1920:54:148:color=0xF4F1EA[paperbase]",
                "[paperbase][1:v]overlay=0:0[framed]",
            ]
            frame_name = "s-frame.png"
        previous = "framed"
        inputs = ["-i", card(frame_name)]
        render_items = overlays + captions

    input_offset = 1 + (1 if inputs else 0)
    for index, (png, start, end) in enumerate(render_items):
        inputs += ["-i", png]
        next_video = f"v{index}"
        chain.append(
            f"[{previous}][{index + input_offset}:v]"
            f"overlay=0:0:enable='between(t,{start:.3f},{end:.3f})'[{next_video}]"
        )
        previous = next_video

    overlay_path = out_path + ".overlay.mp4"
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y", "-i", base, *inputs,
        "-filter_complex", ";".join(chain),
        "-map", f"[{previous}]", "-map", "0:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p", "-c:a", "copy", overlay_path,
    ], check=True)

    target = package.get("editorial", {}).get("targetSeconds", {})
    min_seconds = float(target.get("min", 50.0))
    max_seconds = float(target.get("max", 70.0))
    # Preserve every word and relative scene timing. A small speed correction
    # may fit a slightly slow Ash delivery; a large one is blocked as drift.
    speed = total / (max_seconds - 0.2) if total > max_seconds else 1.0
    if speed > 1.15:
        os.unlink(overlay_path)
        raise ValueError(
            f"Avatar delivery needs {speed:.3f}x speed to fit; rewrite before rendering")
    final_duration = total / speed
    effective_min_seconds = (
        min_seconds - LOCKED_WEEKDAY_DELIVERY_TOLERANCE_SECONDS
        if locked_weekday else min_seconds
    )
    if final_duration < effective_min_seconds:
        os.unlink(overlay_path)
        raise ValueError(
            f"Avatar delivery is {final_duration:.2f}s, below locked minimum "
            f"{effective_min_seconds:.1f}s")
    music_path = os.path.join(cards_dir, "music-bed.wav")
    subprocess.run([
        sys.executable, os.path.join(os.path.dirname(__file__), "make_music.py"),
        f"{final_duration:.5f}", music_path,
    ], check=True)
    mix_path = out_path + ".mix.wav"
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", overlay_path, "-i", music_path,
        "-filter_complex", (
            f"[0:a]atempo={speed:.8f}[voice];"
            "[1:a]volume=0.115[music];"
            "[voice][music]amix=inputs=2:duration=first:normalize=0[mix]"
        ),
        "-map", "[mix]", "-c:a", "pcm_s24le", mix_path,
    ], check=True)

    loudness = measured_loudnorm(mix_path, 1.0)
    audio_filter = (
        "loudnorm=I=-14:TP=-2:LRA=11:"
        f"measured_I={loudness['input_i']}:"
        f"measured_TP={loudness['input_tp']}:"
        f"measured_LRA={loudness['input_lra']}:"
        f"measured_thresh={loudness['input_thresh']}:"
        f"offset={loudness['target_offset']}:linear=true"
    )
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", overlay_path, "-i", mix_path,
        "-vf", f"setpts=PTS/{speed:.8f}",
        "-af", audio_filter,
        "-map", "0:v", "-map", "1:a",
        "-shortest",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
        out_path,
    ], check=True)
    os.unlink(overlay_path)
    os.unlink(mix_path)

    timing_receipt = {
        "schema": "amm-short-timings-v1",
        "subtitleScriptMatch": round(transcript_match, 4),
        "avatarDurationSeconds": round(total, 3),
        "playbackRate": round(speed, 5),
        "finalDurationSeconds": round(duration(out_path), 3),
        "music": {
            "source": "AMM procedural original v1",
            "sha256": sha256(music_path),
            "mixGain": 0.115,
        },
        "templateVersion": package.get("editorial", {}).get("templateVersion"),
        "layout": layout,
        "beats": timings,
        "displayBeats": display_timings,
    }
    with open(os.path.join(cards_dir, "beat-timings.json"), "w") as output:
        json.dump(timing_receipt, output, indent=2)
        output.write("\n")
    print(
        f"finished → {out_path} ({duration(out_path):.1f}s, "
        f"{speed:.3f}x, subtitle match {transcript_match:.1%})"
    )


if __name__ == "__main__":
    main(*sys.argv[1:6])
