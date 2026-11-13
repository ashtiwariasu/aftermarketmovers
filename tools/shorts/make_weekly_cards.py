#!/usr/bin/env python3
"""Locked weekly episode → continuous AMM presenter frame and research cards."""

import html
import json
import os
import sys

from make_cards import FONTS, render


INK = "#16150F"
PAPER = "#F4F1EA"
WHITE = "#FFFDF8"
ORANGE = "#FF4D1F"
BLUE = "#2B4BF2"
LIME = "#D8FA48"


def esc(value: object) -> str:
    return html.escape(str(value))


def signal_color(label: str) -> str:
    label = label.upper()
    if "DOWNSIDE" in label:
        return ORANGE
    if "UPSIDE" in label:
        return BLUE
    return INK


def count_word(count: int) -> str:
    return {5: "FIVE", 6: "SIX"}[count]


def edition_label(package: dict) -> str:
    return "WEEKLY REVIEW" if package["edition"] == "weekly-review" else "WEEK AHEAD"


def rail(label: str) -> str:
    labels = [
        ("STRONG", "DOWN"),
        ("GENTLE", "DOWN"),
        ("NEUTRAL", ""),
        ("GENTLE", "UP"),
        ("STRONG", "UP"),
    ]
    normalized = label.upper()
    active = 2
    if "DOWNSIDE" in normalized:
        active = 0 if "STRONG" in normalized else 1
    elif "UPSIDE" in normalized:
        active = 4 if "STRONG" in normalized else 3
    nodes = []
    xs = [52, 210, 368, 526, 684]
    for index, (top, bottom) in enumerate(labels):
        color = ORANGE if index < 2 else BLUE if index > 2 else INK
        width = 4 if index == active else 2
        nodes.append(
            f'<circle cx="{xs[index]}" cy="34" r="15" fill="{WHITE}" '
            f'stroke="{color}" stroke-width="{width}"/>'
            f'<text x="{xs[index]}" y="73" text-anchor="middle" class="mono" '
            f'font-size="12" font-weight="700" fill="{color}">{top}</text>'
            f'<text x="{xs[index]}" y="90" text-anchor="middle" class="mono" '
            f'font-size="11" font-weight="700" fill="{color}">{bottom}</text>'
        )
    marker = (
        f'<g transform="translate({xs[active]-9},25) rotate(12 9 8)">'
        f'<polygon points="9,0 18,16 0,16" fill="{ORANGE}"/></g>'
    )
    return (
        '<svg viewBox="0 0 736 100" style="display:block;width:100%;height:auto">'
        f'<line x1="52" y1="34" x2="368" y2="34" stroke="{ORANGE}" stroke-width="2"/>'
        f'<line x1="368" y1="34" x2="684" y2="34" stroke="{BLUE}" stroke-width="2"/>'
        + "".join(nodes) + marker + "</svg>"
    )


def reporting_cycle(cycle: dict, lifecycle: str, color: str) -> str:
    start_date = cycle["startDate"]
    end_date = cycle["endDate"]
    publication_date = cycle["publicationDate"]
    from datetime import date

    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    current = date.fromisoformat(publication_date)
    span = max(1, (end - start).days)
    position = min(1.0, max(0.0, (current - start).days / span))
    marker_x = 36 + round(position * 664)
    return f"""
<div class="mono" style="margin-top:26px;padding-top:20px;border-top:2px solid {INK}">
  <div style="display:flex;justify-content:space-between;font-size:14px;
  letter-spacing:1.8px;color:#6D6A62">
    <span>{esc(cycle["startLabel"])}</span>
    <span style="color:{color}">THESIS {esc(lifecycle)}</span>
    <span>{esc(cycle["endLabel"])}</span>
  </div>
  <svg viewBox="0 0 736 50" style="display:block;width:100%;height:auto;margin-top:8px">
    <line x1="36" y1="25" x2="700" y2="25" stroke="#A7A39A" stroke-width="2"/>
    <line x1="36" y1="25" x2="{marker_x}" y2="25" stroke="{color}" stroke-width="5"/>
    <circle cx="36" cy="25" r="6" fill="{color}"/>
    <circle cx="{marker_x}" cy="25" r="11" fill="{WHITE}" stroke="{color}" stroke-width="4"/>
  </svg>
</div>"""


def page(body: str, transparent: bool = False) -> str:
    background = "transparent" if transparent else PAPER
    return f"""<!doctype html><html><head><meta charset="utf-8">{FONTS}
<style>
*{{box-sizing:border-box}}html,body{{margin:0;width:1080px;height:1920px;overflow:hidden}}
body{{background:{background};color:{INK};font-family:Arial,sans-serif}}
.mono{{font-family:"IBM Plex Mono",monospace}}.disp{{font-family:"Bricolage Grotesque",sans-serif}}
.panel{{position:absolute;left:40px;right:40px;top:820px;bottom:56px;background:{WHITE};
border:3px solid {INK};border-radius:28px;box-shadow:10px 12px 0 {INK};padding:44px 50px}}
.eyebrow{{font-size:20px;letter-spacing:4px;font-weight:700}}
</style></head><body>{body}</body></html>"""


def frame_html(package: dict) -> str:
    return page(f"""
<div style="position:absolute;left:38px;top:38px;background:{INK};color:{WHITE};
padding:15px 21px;border-radius:12px" class="mono">
<b style="font-size:26px">AMM</b><span style="color:{ORANGE};font-size:20px"> ▲</span>
<span style="margin-left:30px;font-size:17px;letter-spacing:2px;color:{LIME}">
{edition_label(package)} · {esc(package["publicationDate"])}</span></div>
<div style="position:absolute;right:48px;top:50px;color:{WHITE};font-size:15px;
letter-spacing:2px" class="mono">AI PRESENTER · MATCHED EDITORIAL VOICE</div>
""", transparent=True)


def intro_html(package: dict) -> str:
    tickers = " · ".join(stock["ticker"] for stock in package["stocks"])
    count = count_word(len(package["stocks"]))
    if package["edition"] == "weekly-review":
        eyebrow = f"THE WEEK IN {count} STOCKS"
        headline = "What mattered<br>this week."
        deck = "The clearest evidence-backed thesis reads from AMM’s latest completed research."
    else:
        eyebrow = f"{count} STOCKS · THE WEEK AHEAD"
        headline = "What matters<br>next."
        deck = "The standing theses and company evidence to watch in the new week."
    return page(f"""<div class="panel">
<div class="eyebrow mono" style="color:{ORANGE}">{eyebrow}</div>
<div class="disp" style="font-size:78px;line-height:.98;font-weight:800;margin-top:30px">
{headline}</div>
<div style="font-size:30px;line-height:1.35;margin-top:38px;color:#4F4C46">
{deck}</div>
<div class="mono" style="margin-top:66px;padding-top:32px;border-top:2px solid {INK};
font-size:24px;letter-spacing:3px;color:{BLUE}">{esc(tickers)}</div>
<div class="mono" style="position:absolute;left:50px;bottom:42px;font-size:16px;
letter-spacing:2px;color:#6D6A62">5 FRONTIER ANALYSTS · SOURCES LOCKED · TRACEABLE</div>
</div>""", transparent=True)


def stock_html(package: dict, index: int) -> str:
    editorial = package["editorial"]["stocks"][index]
    state = package["stocks"][index]
    signal = state["signal"]
    label = (
        f'{signal["strength"]} '
        f'{"UPSIDE" if signal["direction"] == "UP" else "DOWNSIDE"}'
    )
    lifecycle = state["lifecycleStatus"].upper()
    support = state["votes"]["support"]
    color = signal_color(label)
    return page(f"""<div class="panel">
<div style="display:flex;align-items:flex-start;justify-content:space-between">
  <div>
    <div class="mono eyebrow" style="color:{ORANGE}">{index + 1:02d} · {lifecycle}</div>
    <div class="disp" style="font-size:78px;line-height:1;font-weight:800;margin-top:12px;
    color:{BLUE}">{esc(state["ticker"])}</div>
  </div>
  <div class="mono" style="text-align:right;font-size:18px;line-height:1.7;letter-spacing:2px">
    <b style="color:{color}">{esc(label)}</b><br>{support}/5 AGREE
  </div>
</div>
<div style="height:2px;background:{INK};margin:25px 0 22px"></div>
<div style="height:104px">{rail(label)}</div>
<div class="disp" style="font-size:36px;line-height:1.12;font-weight:800;margin-top:20px">
{esc(editorial["line1"])}</div>
<div style="font-size:27px;line-height:1.32;margin-top:28px;color:#3E3B36">
{esc(editorial["line2"])}</div>
{reporting_cycle(state["reportingCycle"], lifecycle, color)}
</div>""", transparent=True)


def close_html(package: dict) -> str:
    return page(f"""<div class="panel" style="background:{INK};color:{WHITE}">
<div class="mono eyebrow" style="color:{LIME}">AMM · AFTER MARKET MOVERS</div>
<div class="disp" style="font-size:76px;line-height:1.02;font-weight:800;margin-top:35px">
Every thesis.<br>Every source.<br>Every change.</div>
<div style="font-size:30px;line-height:1.35;color:#C9C5BB;margin-top:38px">
Research the stocks you follow while you sleep.</div>
<div style="position:absolute;left:50px;right:50px;bottom:50px;background:{ORANGE};
color:{WHITE};border:3px solid {WHITE};border-radius:16px;padding:25px 28px;
font-size:28px;text-align:center;font-weight:800">
AFTERMARKETMOVERS.COM <span style="margin-left:12px">→</span></div>
</div>""", transparent=True)


def main(package_path: str, outdir: str) -> None:
    package = json.load(open(package_path))
    if package.get("schema") != "amm-weekly-short-episode-v1":
        raise ValueError("weekly cards require amm-weekly-short-episode-v1")
    if len(package.get("stocks", [])) not in (5, 6):
        raise ValueError("weekly cards require five or six stocks")
    os.makedirs(outdir, exist_ok=True)
    render(frame_html(package), os.path.join(outdir, "weekly-frame.png"), True)
    render(intro_html(package), os.path.join(outdir, "weekly-intro.png"), True)
    for index in range(len(package["stocks"])):
        render(
            stock_html(package, index),
            os.path.join(outdir, f"weekly-stock-{index + 1}.png"),
            True,
        )
    render(close_html(package), os.path.join(outdir, "weekly-close.png"), True)
    print(f"weekly cards → {outdir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
