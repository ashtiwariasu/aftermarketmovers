#!/usr/bin/env python3
"""Objective post-render release gate for AMM Shorts."""
import hashlib
import json
import os
import re
import subprocess
import sys

MAX_DISPLAY_GAP_SECONDS = 0.05
MAX_DISPLAY_HOLD_SECONDS = 1.25
LOCKED_WEEKDAY_TEMPLATE = "amm-weekday-locked-v3"
LOCKED_WEEKDAY_DELIVERY_TOLERANCE_SECONDS = 2.0
LOCKED_WEEKDAY_BEAT_ORDER = (
    "hook", "change", "evidence", "thesis", "council", "close",
)
LEGACY_BEAT_ORDER = ("hook", "change", "thesis", "evidence", "council", "close")
LOCKED_AVATAR_ID = os.environ.get("HEYGEN_LOCKED_AVATAR_ID", "")
LOCKED_AVATAR_NAME = os.environ.get("HEYGEN_PRESENTER_NAME", "")
LOCKED_VOICE_ID = os.environ.get("HEYGEN_LOCKED_VOICE_ID", "")
LOCKED_VOICE_NAME = os.environ.get("HEYGEN_VOICE_NAME", "")
LOCKED_WEEKDAY_END_WINDOWS = {
    # The script ranges are the first, cost-free drift gate. These post-render
    # windows are intentionally wider than the editorial targets so natural
    # delivery survives while a reordered or bloated scene is still blocked.
    "hook": (1.5, 5.5),
    "change": (7.0, 14.5),
    "evidence": (13.0, 24.5),
    "thesis": (20.0, 32.0),
    "council": (28.0, 40.0),
    "close": (33.5, 46.5),
}


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result.stdout + result.stderr


def probe(path: str) -> dict:
    return json.loads(run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format",
        "-of", "json", path,
    ]))


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(video: str, package_path: str, manifest_path: str, receipt_path: str) -> None:
    package = json.load(open(package_path))
    manifest = json.load(open(manifest_path))
    metadata = probe(video)
    streams = metadata.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    duration = float(metadata.get("format", {}).get("duration", 0))
    template_version = package.get("editorial", {}).get("templateVersion")
    target = package.get("editorial", {}).get("targetSeconds", {})
    min_seconds = float(target.get("min", 50.0))
    max_seconds = float(target.get("max", 70.0))
    locked_weekday = template_version == LOCKED_WEEKDAY_TEMPLATE
    issues = []
    effective_min_seconds = (
        min_seconds - LOCKED_WEEKDAY_DELIVERY_TOLERANCE_SECONDS
        if locked_weekday else min_seconds
    )
    if not (effective_min_seconds <= duration <= max_seconds):
        issues.append(
            f"duration {duration:.2f}s is outside "
            f"{effective_min_seconds:.1f}–{max_seconds:.0f}s")
    if not video_stream:
        issues.append("missing video stream")
    else:
        if (video_stream.get("width"), video_stream.get("height")) != (1080, 1920):
            issues.append(
                f"video is {video_stream.get('width')}x{video_stream.get('height')}, expected 1080x1920")
        if video_stream.get("codec_name") != "h264":
            issues.append(f"video codec is {video_stream.get('codec_name')}, expected h264")
        if video_stream.get("pix_fmt") != "yuv420p":
            issues.append(f"pixel format is {video_stream.get('pix_fmt')}, expected yuv420p")
    if not audio_stream:
        issues.append("missing audio stream")
    if manifest.get("avatarEngine") != "avatar_v":
        issues.append(
            f"avatar engine is {manifest.get('avatarEngine')!r}, expected 'avatar_v'")
    if not manifest.get("avatarId"):
        issues.append("render manifest has no avatar id")
    if locked_weekday and LOCKED_AVATAR_ID and manifest.get("avatarId") != LOCKED_AVATAR_ID:
        issues.append(
            f"avatar is {manifest.get('avatarId')!r}, expected locked Ash avatar "
            f"{LOCKED_AVATAR_ID!r}")
    if locked_weekday and LOCKED_AVATAR_NAME and manifest.get("avatarName") != LOCKED_AVATAR_NAME:
        issues.append(
            f"avatar name is {manifest.get('avatarName')!r}, expected locked "
            f"weekday presenter {LOCKED_AVATAR_NAME!r}")
    if not manifest.get("voiceName"):
        issues.append("render manifest has no voice name")
    if locked_weekday and LOCKED_VOICE_NAME and manifest.get("voiceName") != LOCKED_VOICE_NAME:
        issues.append(
            f"voice is {manifest.get('voiceName')!r}, expected locked weekday "
            f"voice {LOCKED_VOICE_NAME!r}")
    if locked_weekday and LOCKED_VOICE_ID and manifest.get("voiceId") != LOCKED_VOICE_ID:
        issues.append(
            f"voice id is {manifest.get('voiceId')!r}, expected locked Ash voice")
    music_path = os.path.join(os.path.dirname(manifest_path), "music-bed.wav")
    if not os.path.isfile(music_path):
        issues.append("missing original AMM music bed")
    timings_path = os.path.join(os.path.dirname(manifest_path), "beat-timings.json")
    timings = json.load(open(timings_path)) if os.path.isfile(timings_path) else {}
    if timings.get("templateVersion") != template_version:
        issues.append("timing receipt template version does not match episode package")
    if locked_weekday and timings.get("layout") != LOCKED_WEEKDAY_TEMPLATE:
        issues.append("locked weekday layout was not used")
    display_beats = timings.get("displayBeats", {})
    spoken_beats = timings.get("beats", {})
    display_order = LOCKED_WEEKDAY_BEAT_ORDER if locked_weekday else LEGACY_BEAT_ORDER
    if tuple(display_beats) != display_order:
        issues.append("timing receipt does not contain the complete ordered display-beat contract")
    else:
        display_cursor = 0.0
        for name in display_order:
            span = display_beats[name]
            start = float(span.get("start", -1))
            end = float(span.get("end", -1))
            if end <= start:
                issues.append(f"display beat {name} has invalid span {start:.3f}–{end:.3f}")
            gap = start - display_cursor
            if gap > MAX_DISPLAY_GAP_SECONDS:
                issues.append(
                    f"display panel is uncovered for {gap:.3f}s before {name}")
            if start < display_cursor - MAX_DISPLAY_GAP_SECONDS:
                issues.append(
                    f"display beat {name} overlaps the previous beat by "
                    f"{display_cursor - start:.3f}s")
            display_cursor = max(display_cursor, end)
        if display_cursor < float(timings.get("avatarDurationSeconds", duration)):
            issues.append(
                "display panel becomes uncovered before the presenter performance ends")

    if locked_weekday:
        if tuple(spoken_beats) != LOCKED_WEEKDAY_BEAT_ORDER:
            issues.append(
                "timing receipt does not contain the complete ordered spoken-beat contract")
        else:
            for name in LOCKED_WEEKDAY_BEAT_ORDER:
                spoken_span = spoken_beats[name]
                spoken_start = float(spoken_span.get("start", -1))
                spoken_end = float(spoken_span.get("end", -1))
                if spoken_end <= spoken_start:
                    issues.append(
                        f"spoken beat {name} has invalid span "
                        f"{spoken_start:.3f}–{spoken_end:.3f}")
                    continue
                minimum, maximum = LOCKED_WEEKDAY_END_WINDOWS[name]
                if not minimum <= spoken_end <= maximum:
                    issues.append(
                        f"locked weekday {name} spoken beat ends at "
                        f"{spoken_end:.2f}s; allowed window is "
                        f"{minimum:.1f}–{maximum:.1f}s")
                display_end = float(
                    display_beats.get(name, {}).get("end", spoken_end))
                hold_seconds = display_end - spoken_end
                if hold_seconds < -MAX_DISPLAY_GAP_SECONDS:
                    issues.append(
                        f"display scene {name} ends {abs(hold_seconds):.3f}s "
                        "before its spoken beat")
                if hold_seconds > MAX_DISPLAY_HOLD_SECONDS:
                    issues.append(
                        f"display scene {name} holds for {hold_seconds:.3f}s "
                        "after speech; maximum is "
                        f"{MAX_DISPLAY_HOLD_SECONDS:.2f}s")
        cards_dir = os.path.dirname(manifest_path)
        visual_plan_path = os.path.join(cards_dir, "weekday-visual-plan.json")
        if not os.path.isfile(visual_plan_path):
            issues.append("locked weekday visual plan is missing")
        else:
            visual_plan = json.load(open(visual_plan_path))
            expected_scenes = [
                {"beat": beat, "file": f"weekday-{index:02d}-{beat}.png"}
                for index, beat in enumerate(LOCKED_WEEKDAY_BEAT_ORDER, start=1)
            ]
            actual_scenes = [
                {"beat": scene.get("beat"), "file": scene.get("file")}
                for scene in visual_plan.get("scenes", [])
            ]
            if visual_plan.get("templateVersion") != LOCKED_WEEKDAY_TEMPLATE:
                issues.append("locked weekday visual plan template version drifted")
            if actual_scenes != expected_scenes:
                issues.append("locked weekday visual plan scene order drifted")
            missing_scenes = [
                scene["file"]
                for scene in expected_scenes
                if not os.path.isfile(os.path.join(cards_dir, scene["file"]))
            ]
            if missing_scenes:
                issues.append(
                    "locked weekday scene renders are missing: "
                    + ", ".join(missing_scenes))
            if visual_plan.get("spokenCta") != (
                "For daily thesis updates and evidence, "
                "visit aftermarketmovers dot com."
            ):
                issues.append("locked weekday spoken CTA drifted")
            if visual_plan.get("visualCta") != "TRACK THE THESIS DAILY":
                issues.append("locked weekday visual CTA drifted")

    loudness_output = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-",
    ])
    blocks = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", loudness_output)
    loudness = json.loads(blocks[-1]) if blocks else {}
    output_i = float(loudness.get("input_i", -99))
    output_tp = float(loudness.get("input_tp", 99))
    if not (-15.0 <= output_i <= -13.0):
        issues.append(f"integrated loudness is {output_i:.2f} LUFS, expected -14±1")
    if output_tp > -0.5:
        issues.append(f"true peak is {output_tp:.2f} dBTP, expected ≤ -0.5")

    black = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-vf", "blackdetect=d=0.8:pix_th=0.04", "-an", "-f", "null", "-",
    ])
    black_segments = re.findall(r"black_start:([0-9.]+)\s+black_end:([0-9.]+)", black)
    if black_segments:
        issues.append(f"black frames detected: {black_segments[:3]}")

    silence = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-af", "silencedetect=noise=-38dB:d=1.2", "-f", "null", "-",
    ])
    long_silences = re.findall(
        r"silence_start: ([0-9.]+)[\s\S]*?silence_end: ([0-9.]+)", silence)
    if long_silences:
        issues.append(f"long silence detected: {long_silences[:3]}")

    receipt = {
        "schema": "amm-short-qc-v1",
        "episodeId": package.get("episodeId"),
        "templateVersion": template_version,
        "dossierSha256": package.get("dossier", {}).get("sha256"),
        "sourceBundleSha256": package.get("provenance", {}).get("sourceBundleSha256"),
        "videoSha256": sha256(video),
        "durationSeconds": round(duration, 3),
        "width": video_stream.get("width") if video_stream else None,
        "height": video_stream.get("height") if video_stream else None,
        "videoCodec": video_stream.get("codec_name") if video_stream else None,
        "audioCodec": audio_stream.get("codec_name") if audio_stream else None,
        "integratedLufs": output_i,
        "truePeakDbtp": output_tp,
        "heygen": {
            "videoId": manifest.get("videoId"),
            "avatarEngine": manifest.get("avatarEngine"),
            "avatarId": manifest.get("avatarId"),
            "avatarName": manifest.get("avatarName"),
            "voiceId": manifest.get("voiceId"),
            "voiceName": manifest.get("voiceName"),
        },
        "music": {
            "source": "AMM procedural original v1",
            "sha256": sha256(music_path) if os.path.isfile(music_path) else None,
        },
        "layout": timings.get("layout"),
        "spokenBeats": spoken_beats,
        "displayBeats": display_beats,
        "status": "pass" if not issues else "fail",
        "issues": issues,
    }
    with open(receipt_path, "w") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    if issues:
        sys.exit("SHORT BLOCKED:\n- " + "\n- ".join(issues))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main(*sys.argv[1:5])
