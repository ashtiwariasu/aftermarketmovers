#!/usr/bin/env python3
"""Build the single-render HeyGen Avatar V request from a locked episode."""

import json
import sys


BEAT_ORDER = ("hook", "change", "thesis", "evidence", "council", "close")
LOCKED_WEEKDAY_BEAT_ORDER = (
    "hook", "change", "evidence", "thesis", "council", "close",
)
LOCKED_WEEKDAY_TEMPLATE = "amm-weekday-locked-v3"


def beat_order(package: dict) -> tuple[str, ...]:
    if package.get("editorial", {}).get("templateVersion") == LOCKED_WEEKDAY_TEMPLATE:
        return LOCKED_WEEKDAY_BEAT_ORDER
    return BEAT_ORDER


def main(package_path: str, output_path: str, avatar_id: str, voice_id: str) -> None:
    package = json.load(open(package_path))
    if package.get("schema") != "amm-short-episode-v1":
        raise ValueError("HeyGen accepts only a validated amm-short-episode-v1 package")

    beats = package["editorial"]["beats"]
    order = beat_order(package)
    missing = [name for name in order if not beats.get(name, {}).get("text", "").strip()]
    if missing:
        raise ValueError(f"episode has empty spoken beats: {', '.join(missing)}")

    # Newlines give the speaker natural phrase boundaries without injecting
    # unsupported SSML or any text that is not in the audited package.
    script = "\n\n".join(beats[name]["text"].strip() for name in order)
    publication_date = (
        package.get("reportingCycle", {}).get("publicationDate")
        or package["dossier"]["date"]
    )
    format_label = "Weekend Recap" if package.get("format") == "weekend-recap" else "Short"
    payload = {
        "type": "avatar",
        "avatar_id": avatar_id,
        "title": (
            f'AMM {format_label} - {package["dossier"]["ticker"]} - '
            f'{publication_date} - {package["episodeId"][:8]}'
        ),
        "resolution": "1080p",
        "aspect_ratio": "9:16",
        "fit": "cover",
        "output_format": "mp4",
        "script": script,
        "voice_id": voice_id,
        "voice_settings": {
            "speed": 1.0,
            "pitch": 0,
            "volume": 1.0,
            "locale": "en-US",
        },
        "caption": {"file_format": "srt"},
        "engine": {"type": "avatar_v"},
    }
    with open(output_path, "w") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:5])
