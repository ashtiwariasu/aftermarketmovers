#!/usr/bin/env python3
"""Continuous Avatar V presenter + timed weekly AMM stock cards."""

import difflib
import json
import os
import subprocess
import sys

from finish import (
    duration,
    measured_loudnorm,
    parse_srt,
    sha256,
    tokens,
)


def derive_segments(package: dict, cues: list[dict]) -> tuple[list[dict], float]:
    named = [("intro", package["editorial"]["intro"])]
    for index, stock in enumerate(package["editorial"]["stocks"], start=1):
        named.append((f"stock-{index}", f'{stock["line1"]} {stock["line2"]}'))
    named.append(("close", package["editorial"]["close"]))
    expected: list[str] = []
    ranges: list[tuple[str, int, int]] = []
    for name, text in named:
        start = len(expected)
        expected.extend(tokens(text))
        ranges.append((name, start, len(expected)))
    observed: list[str] = []
    observed_times: list[tuple[float, float]] = []
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
    if matcher.ratio() < 0.90:
        raise ValueError(
            f"weekly subtitle/script match is only {matcher.ratio():.1%}")
    mapping: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            mapping[block.a + offset] = block.b + offset
    if not mapping:
        raise ValueError("weekly subtitle matcher found no aligned speech")

    def observed_index(index: int) -> int:
        if index in mapping:
            return mapping[index]
        nearest = min(mapping, key=lambda candidate: abs(candidate - index))
        return max(0, min(len(observed_times) - 1, mapping[nearest] + index - nearest))

    segments = []
    for name, first, after_last in ranges:
        first_observed = observed_index(first)
        last_observed = observed_index(after_last - 1)
        segments.append({
            "name": name,
            "speechStart": round(observed_times[first_observed][0], 3),
            "speechEnd": round(observed_times[last_observed][1], 3),
        })
    return segments, matcher.ratio()


def main(base: str, subtitles: str, work: str, package_path: str, out_path: str) -> None:
    package = json.load(open(package_path))
    if package.get("schema") != "amm-weekly-short-episode-v1":
        raise ValueError("weekly finish requires amm-weekly-short-episode-v1")
    total = duration(base)
    segments, transcript_match = derive_segments(package, parse_srt(subtitles))
    for index, segment in enumerate(segments):
        segment["displayStart"] = 0.0 if index == 0 else segment["speechStart"]
        segment["displayEnd"] = (
            segments[index + 1]["speechStart"] if index + 1 < len(segments) else total + 0.2
        )
    inputs = ["-i", os.path.join(work, "weekly-frame.png")]
    chain = [
        "[0:v]crop=1080:1120:0:0,scale=1000:1037:flags=lanczos,"
        "pad=1080:1920:40:116:color=0xF4F1EA[paperbase]",
        "[paperbase][1:v]overlay=0:0[framed]",
    ]
    previous = "framed"
    for index, segment in enumerate(segments):
        png = (
            "weekly-intro.png" if segment["name"] == "intro"
            else "weekly-close.png" if segment["name"] == "close"
            else f'{segment["name"].replace("stock-", "weekly-stock-")}.png'
        )
        inputs += ["-i", os.path.join(work, png)]
        next_name = f"w{index}"
        chain.append(
            f"[{previous}][{index + 2}:v]overlay=0:0:"
            f"enable='between(t,{segment['displayStart']:.3f},{segment['displayEnd']:.3f})'"
            f"[{next_name}]"
        )
        previous = next_name
    overlay_path = out_path + ".overlay.mp4"
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y", "-i", base, *inputs,
        "-filter_complex", ";".join(chain),
        "-map", f"[{previous}]", "-map", "0:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p", "-c:a", "copy", overlay_path,
    ], check=True)
    speed = total / 69.5 if total > 70 else 1.0
    if speed > 1.15:
        os.unlink(overlay_path)
        raise ValueError(
            f"weekly delivery needs {speed:.3f}x speed; rewrite before rendering")
    final_duration = total / speed
    music_path = os.path.join(work, "music-bed.wav")
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
            "[1:a]volume=0.105[music];"
            "[voice][music]amix=inputs=2:duration=first:normalize=0[mix]"
        ),
        "-map", "[mix]", "-c:a", "pcm_s24le", mix_path,
    ], check=True)
    loudness = measured_loudnorm(mix_path, 1.0)
    audio_filter = (
        "loudnorm=I=-14:TP=-2:LRA=11:"
        f"measured_I={loudness['input_i']}:measured_TP={loudness['input_tp']}:"
        f"measured_LRA={loudness['input_lra']}:"
        f"measured_thresh={loudness['input_thresh']}:"
        f"offset={loudness['target_offset']}:linear=true"
    )
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", overlay_path, "-i", mix_path,
        "-vf", f"setpts=PTS/{speed:.8f}", "-af", audio_filter,
        "-map", "0:v", "-map", "1:a", "-shortest",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", out_path,
    ], check=True)
    os.unlink(overlay_path)
    os.unlink(mix_path)
    receipt = {
        "schema": "amm-weekly-short-timings-v1",
        "subtitleScriptMatch": round(transcript_match, 4),
        "avatarDurationSeconds": round(total, 3),
        "playbackRate": round(speed, 5),
        "finalDurationSeconds": round(duration(out_path), 3),
        "music": {
            "source": "AMM procedural original v1",
            "sha256": sha256(music_path),
            "mixGain": 0.105,
        },
        "segments": segments,
    }
    with open(os.path.join(work, "weekly-timings.json"), "w") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(
        f"weekly finished → {out_path} ({duration(out_path):.1f}s, "
        f"{speed:.3f}x, transcript {transcript_match:.1%})"
    )


if __name__ == "__main__":
    main(*sys.argv[1:6])
