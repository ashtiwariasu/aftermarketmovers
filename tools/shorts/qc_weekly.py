#!/usr/bin/env python3
"""Fail-closed objective release gate for the 5–6 stock weekly Short."""

import json
import os
import re
import subprocess
import sys

from qc import probe, run, sha256

EXPECTED_AVATAR = "a0e959fae7734dd194867b4c927616be"
EXPECTED_AVATAR_NAME = "Confident professional in a modern office"
EXPECTED_VOICE = "piUdgk6WsLl3OR5GSW0j"
EXPECTED_VOICE_NAME = "Sharp Analyst (US)"


def main(video: str, package_path: str, manifest_path: str, receipt_path: str) -> None:
    package = json.load(open(package_path))
    manifest = json.load(open(manifest_path))
    metadata = probe(video)
    streams = metadata.get("streams", [])
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio_stream = next((item for item in streams if item.get("codec_type") == "audio"), None)
    duration = float(metadata.get("format", {}).get("duration", 0))
    issues: list[str] = []
    if package.get("schema") != "amm-weekly-short-episode-v1":
        issues.append("invalid weekly episode schema")
    if len(package.get("stocks", [])) not in (5, 6):
        issues.append("weekly episode does not contain five or six stocks")
    if not (50 <= duration <= 70):
        issues.append(f"duration {duration:.2f}s is outside 50–70s")
    if not video_stream:
        issues.append("missing video stream")
    else:
        if (video_stream.get("width"), video_stream.get("height")) != (1080, 1920):
            issues.append("weekly video is not 1080x1920")
        if video_stream.get("codec_name") != "h264":
            issues.append("weekly video is not H.264")
        if video_stream.get("pix_fmt") != "yuv420p":
            issues.append("weekly video is not yuv420p")
    if not audio_stream:
        issues.append("missing audio stream")
    if manifest.get("avatarEngine") != "avatar_v":
        issues.append("weekly presenter is not Avatar V")
    if manifest.get("avatarId") != EXPECTED_AVATAR:
        issues.append("weekly presenter is not the locked modern-office look")
    if manifest.get("avatarName") != EXPECTED_AVATAR_NAME:
        issues.append("weekly presenter name does not match the locked modern-office look")
    if (
        manifest.get("voiceId") != EXPECTED_VOICE or
        manifest.get("voiceName") != EXPECTED_VOICE_NAME
    ):
        issues.append("weekly voice is not the presenter's locked matching voice")
    timing_path = os.path.join(os.path.dirname(manifest_path), "weekly-timings.json")
    timings = json.load(open(timing_path)) if os.path.isfile(timing_path) else {}
    segments = timings.get("segments", [])
    expected_names = (
        ["intro"] +
        [f"stock-{index}" for index in range(1, len(package.get("stocks", [])) + 1)] +
        ["close"]
    )
    if [segment.get("name") for segment in segments] != expected_names:
        issues.append("weekly timing receipt is missing ordered intro/stock/close panels")
    else:
        cursor = 0.0
        for segment in segments:
            start = float(segment.get("displayStart", -1))
            end = float(segment.get("displayEnd", -1))
            if abs(start - cursor) > 0.06:
                issues.append(f"display discontinuity before {segment['name']}")
            if end <= start:
                issues.append(f"invalid display span for {segment['name']}")
            cursor = end
        if cursor < float(timings.get("avatarDurationSeconds", duration)):
            issues.append("weekly visual ends before the presenter")
    loudness_output = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
        "-f", "null", "-",
    ])
    blocks = re.findall(r'\{\s*"input_i"[\s\S]*?\}', loudness_output)
    loudness = json.loads(blocks[-1]) if blocks else {}
    integrated = float(loudness.get("input_i", -99))
    peak = float(loudness.get("input_tp", 99))
    if not (-15 <= integrated <= -13):
        issues.append(f"integrated loudness is {integrated:.2f} LUFS")
    if peak > -0.5:
        issues.append(f"true peak is {peak:.2f} dBTP")
    black = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-vf", "blackdetect=d=0.8:pix_th=0.04", "-an", "-f", "null", "-",
    ])
    if re.search(r"black_start:", black):
        issues.append("black frames detected")
    silence = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", video,
        "-af", "silencedetect=noise=-38dB:d=1.2", "-f", "null", "-",
    ])
    if re.search(r"silence_start:", silence):
        issues.append("long silence detected")
    music_path = os.path.join(os.path.dirname(manifest_path), "music-bed.wav")
    if not os.path.isfile(music_path):
        issues.append("missing original AMM music bed")
    receipt = {
        "schema": "amm-weekly-short-qc-v1",
        "episodeId": package.get("episodeId"),
        "sourceBundleSha256": package.get("provenance", {}).get("sourceBundleSha256"),
        "videoSha256": sha256(video),
        "durationSeconds": round(duration, 3),
        "integratedLufs": integrated,
        "truePeakDbtp": peak,
        "presenter": {
            "engine": manifest.get("avatarEngine"),
            "avatarId": manifest.get("avatarId"),
            "voiceId": manifest.get("voiceId"),
            "voiceName": manifest.get("voiceName"),
        },
        "stocks": [stock["ticker"] for stock in package.get("stocks", [])],
        "segments": segments,
        "status": "pass" if not issues else "fail",
        "issues": issues,
    }
    with open(receipt_path, "w") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    if issues:
        sys.exit("WEEKLY SHORT BLOCKED:\n- " + "\n- ".join(issues))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main(*sys.argv[1:5])
