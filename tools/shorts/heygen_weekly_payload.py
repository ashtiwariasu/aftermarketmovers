#!/usr/bin/env python3
"""Build the locked 5–6 stock non-trading briefing request for HeyGen Avatar V."""

import json
import sys


def main(package_path: str, output_path: str, avatar_id: str, voice_id: str) -> None:
    package = json.load(open(package_path))
    if package.get("schema") != "amm-weekly-short-episode-v1":
        raise ValueError("weekly HeyGen render requires amm-weekly-short-episode-v1")
    stocks = package.get("editorial", {}).get("stocks", [])
    if len(stocks) not in (5, 6):
        raise ValueError("weekly HeyGen render requires five or six stocks")
    script = package["editorial"]["script"].strip()
    if not script:
        raise ValueError("weekly episode has no locked narration")
    edition = package.get("edition", "weekly-review")
    title = "AMM Weekly Review" if edition == "weekly-review" else "AMM Week Ahead"
    payload = {
        "type": "avatar",
        "avatar_id": avatar_id,
        "title": f'{title} - {package["publicationDate"]} - {package["episodeId"][:12]}',
        "resolution": "1080p",
        "aspect_ratio": "9:16",
        "fit": "cover",
        "output_format": "mp4",
        "script": script,
        "voice_id": voice_id,
        "voice_settings": {
            # A small lift removes the tell-tale synthetic pause while keeping
            # the fixed presenter-matched voice clear on financial quantities.
            "speed": 1.08,
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
