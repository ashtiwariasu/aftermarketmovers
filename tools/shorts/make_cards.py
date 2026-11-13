#!/usr/bin/env python3
"""Validated episode package → branded 1080×1920 stills and caption chips."""
import base64, html, json, os, re, shutil, subprocess, sys, tempfile
from datetime import date

CHROME_CANDIDATES = [
    os.environ.get("CHROME_BIN", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]
HERE = os.path.dirname(os.path.abspath(__file__))

FONTS = (
    '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800'
    '&family=IBM+Plex+Mono:wght@400;600;700&display=block" rel="stylesheet">'
    '<style>.disp{font-family:"Bricolage Grotesque",sans-serif;}'
    '.mono{font-family:"IBM Plex Mono",monospace;}'
    '.chip{position:absolute;top:64px;right:64px;background:#16150F;color:#F4F1EA;'
    'font-family:"IBM Plex Mono",monospace;font-size:24px;letter-spacing:.1em;'
    'font-weight:700;padding:12px 20px;border-radius:8px;}'
    '.ppcard{box-sizing:border-box;background:#FFFDF8;border:3px solid #16150F;'
    'box-shadow:10px 10px 0 #16150F;}</style>'
)

TRI_FULL = (
    '<svg class="t" width="100" height="92" viewBox="0 0 12 11">'
    '<g transform="rotate(12 6 5.5)">'
    '<polygon points="6,0 12,11 0,11" fill="#FF4D1F"/></g></svg>'
)
TRI_HOLLOW = (
    '<svg class="t" width="100" height="92" viewBox="0 0 12 11">'
    '<g transform="rotate(12 6 5.5)">'
    '<polygon points="6,0.8 11.3,10.5 0.7,10.5" fill="none" '
    'stroke="rgba(22,21,15,.4)" stroke-width="0.9"/></g></svg>'
)


def chrome_bin() -> str:
    for candidate in CHROME_CANDIDATES:
        if candidate and (os.path.isfile(candidate) or shutil.which(candidate)):
            return candidate
    raise RuntimeError("Chrome/Chromium not found; set CHROME_BIN")


def render(html: str, out_png: str, transparent: bool = False) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        page = f.name
    raw = out_png + ".raw.png"
    cmd = [
        chrome_bin(),
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        f"--screenshot={raw}",
        "--window-size=1080,1920",
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
        "--virtual-time-budget=9000",
    ]
    # The daily Shorts renderer runs inside an isolated Cloud Run container as
    # root. Chromium refuses that execution mode unless its process sandbox is
    # disabled; the container remains isolated by Cloud Run.
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        cmd.append("--no-sandbox")
    if transparent:
        cmd.append("--default-background-color=00000000")
    try:
        chromium = subprocess.run(
            cmd + [f"file://{page}"],
            check=False,
            capture_output=True,
            text=True,
        )
        if chromium.returncode != 0:
            detail = (chromium.stderr or chromium.stdout or "no Chromium output").strip()
            raise RuntimeError(
                f"Chromium card render failed (exit {chromium.returncode}): "
                f"{detail[-4000:]}"
            )
        if not os.path.isfile(raw) or os.path.getsize(raw) == 0:
            raise RuntimeError("Chromium reported success but produced no screenshot")
        subprocess.run([
            "ffmpeg", "-loglevel", "error", "-y", "-i", raw,
            "-vf", "scale=1080:1920:flags=lanczos,setsar=1", "-frames:v", "1", out_png,
        ], check=True)
    finally:
        for artifact in (raw, page):
            try:
                os.unlink(artifact)
            except FileNotFoundError:
                pass


def tpl(name: str) -> str:
    with open(os.path.join(HERE, "cards", name)) as f:
        return f.read()


def fill(template: str, values: dict) -> str:
    out = template.replace("{{FONTS}}", FONTS)
    for k, v in values.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def asset_data_uri(path: str) -> str:
    with open(path, "rb") as asset:
        return "data:image/png;base64," + base64.b64encode(asset.read()).decode("ascii")


def direction_rail(direction: str, strength: str) -> str:
    labels = [
        ("DOWNSIDE", "STRONG", "#FF4D1F"),
        ("DOWNSIDE", "GENTLE", "#FF4D1F"),
        ("NEUTRAL", "NEUTRAL", "#16150F"),
        ("UPSIDE", "GENTLE", "#2B4BF2"),
        ("UPSIDE", "STRONG", "#2B4BF2"),
    ]
    active = 2
    if direction == "DOWN": active = 0 if strength == "STRONG" else 1
    if direction == "UP": active = 4 if strength == "STRONG" else 3
    # MODERATE is intentionally shown between gentle and strong.
    moderate = strength == "MODERATE"
    pos = [50, 265, 480, 695, 910]
    active_x = (pos[active] + pos[active + (-1 if direction == "UP" else 1)]) / 2 if moderate else pos[active]
    nodes = []
    for i, (side, label, color) in enumerate(labels):
        stroke = color if i != 2 else "#16150F"
        nodes.append(
            f'<circle cx="{pos[i]}" cy="72" r="24" fill="#FFFDF8" stroke="{stroke}" stroke-width="4"/>'
            f'<text x="{pos[i]}" y="130" text-anchor="middle" font-family="IBM Plex Mono,monospace" '
            f'font-size="18" font-weight="700" fill="{stroke}">{label}</text>'
            f'<text x="{pos[i]}" y="153" text-anchor="middle" font-family="IBM Plex Mono,monospace" '
            f'font-size="14" font-weight="700" fill="{stroke}">{side}</text>'
        )
    marker_color = "#FF4D1F" if direction == "DOWN" else (
        "#2B4BF2" if direction == "UP" else "#16150F"
    )
    marker = (
        f'<circle cx="{active_x}" cy="72" r="38" fill="#FFFDF8" '
        f'stroke="{marker_color}" stroke-width="5"/>'
        f'<circle cx="{active_x}" cy="72" r="30" fill="none" '
        f'stroke="{marker_color}" stroke-width="3"/>'
        f'<g transform="translate({active_x-12},60) rotate(12 12 11)">'
        '<polygon points="12,0 24,22 0,22" fill="#FF4D1F"/></g>'
    )
    return (
        '<svg viewBox="0 0 960 170" style="display:block;width:100%;height:auto">'
        '<line x1="50" y1="72" x2="480" y2="72" stroke="#FF4D1F" stroke-width="4"/>'
        '<line x1="480" y1="72" x2="910" y2="72" stroke="#2B4BF2" stroke-width="4"/>'
        + "".join(nodes) + marker + "</svg>"
    )


def signal_score(label: str) -> float:
    normalized = label.upper().strip()
    values = {
        "STRONG DOWNSIDE": -2.0,
        "MODERATE DOWNSIDE": -1.5,
        "GENTLE DOWNSIDE": -1.0,
        "NEUTRAL": 0.0,
        "GENTLE UPSIDE": 1.0,
        "MODERATE UPSIDE": 1.5,
        "STRONG UPSIDE": 2.0,
    }
    return values.get(normalized, 0.0)


def thesis_movement(lifecycle: dict) -> str:
    canonical = signal_score(str(lifecycle["canonicalLabel"]))
    current = signal_score(str(lifecycle["currentLabel"]))
    # This intentionally shows only the two states the immutable episode can
    # prove: the opened read and today's admitted read. It never fabricates
    # intermediate daily points when the package does not contain them.
    y = lambda score: 84 - ((score + 2.0) / 4.0) * 62
    start_y = y(canonical)
    current_y = y(current)
    status = str(lifecycle["status"]).upper()
    return (
        '<svg viewBox="0 0 900 164" style="display:block;width:100%;height:auto">'
        '<line x1="54" y1="84" x2="846" y2="84" stroke="rgba(22,21,15,.25)" '
        'stroke-width="2" stroke-dasharray="5 7"/>'
        f'<path d="M54 {start_y:.1f} H710 V{current_y:.1f}" fill="none" '
        'stroke="#2B4BF2" stroke-width="4"/>'
        f'<circle cx="54" cy="{start_y:.1f}" r="9" fill="#FFFDF8" '
        'stroke="#2B4BF2" stroke-width="4"/>'
        f'<circle cx="710" cy="{current_y:.1f}" r="24" fill="#FFFDF8" '
        'stroke="#2B4BF2" stroke-width="4"/>'
        f'<g transform="translate(698,{current_y-11:.1f}) rotate(12 12 11)">'
        '<polygon points="12,0 24,22 0,22" fill="#FF4D1F"/></g>'
        '<line x1="710" y1="108" x2="846" y2="108" stroke="rgba(22,21,15,.35)" '
        'stroke-width="2" stroke-dasharray="5 7"/>'
        '<text x="54" y="138" font-family="IBM Plex Mono,monospace" font-size="16" '
        'font-weight="700" fill="#6D6A62">OPENED</text>'
        '<text x="710" y="138" text-anchor="middle" font-family="IBM Plex Mono,monospace" '
        f'font-size="16" font-weight="700" fill="#2B4BF2">TODAY · {status}</text>'
        '</svg>'
    )


def reporting_cycle(cycle: dict) -> str:
    start = date.fromisoformat(str(cycle["startDate"]))
    end = date.fromisoformat(str(cycle["endDate"]))
    published = date.fromisoformat(str(cycle["publicationDate"]))
    span = max(1, (end - start).days)
    progress = max(0.0, min(1.0, (published - start).days / span))
    x = 54 + progress * 792
    return (
        '<svg viewBox="0 0 900 164" style="display:block;width:100%;height:auto">'
        '<line x1="54" y1="72" x2="846" y2="72" stroke="rgba(22,21,15,.28)" '
        'stroke-width="3"/>'
        '<circle cx="54" cy="72" r="9" fill="#2B4BF2"/>'
        '<circle cx="846" cy="72" r="9" fill="#FFFDF8" stroke="#2B4BF2" stroke-width="4"/>'
        f'<line x1="54" y1="72" x2="{x:.1f}" y2="72" stroke="#2B4BF2" stroke-width="5"/>'
        f'<line x1="{x:.1f}" y1="35" x2="{x:.1f}" y2="108" stroke="#FF4D1F" '
        'stroke-width="3"/>'
        f'<g transform="translate({x-12:.1f},20) rotate(12 12 11)">'
        '<polygon points="12,0 24,22 0,22" fill="#FF4D1F"/></g>'
        f'<text x="{x:.1f}" y="132" text-anchor="middle" '
        'font-family="IBM Plex Mono,monospace" font-size="15" font-weight="700" '
        'fill="#FF4D1F">WEEKEND READ</text>'
        '<text x="54" y="154" font-family="IBM Plex Mono,monospace" font-size="15" '
        f'font-weight="700" fill="#2B4BF2">{html.escape(str(cycle["startLabel"]))}</text>'
        '<text x="846" y="154" text-anchor="end" font-family="IBM Plex Mono,monospace" '
        f'font-size="15" font-weight="700" fill="#2B4BF2">{html.escape(str(cycle["endLabel"]))}</text>'
        '</svg>'
    )


def compact(value: str, max_chars: int) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= max_chars:
        return value
    cut = value[:max_chars - 1].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:-") + "…"


def title_size(value: str, large: bool) -> int:
    length = len(re.sub(r"\s+", " ", value).strip())
    if large:
        if length <= 74:
            return 76
        if length <= 112:
            return 68
        return 60
    if length <= 74:
        return 47
    if length <= 112:
        return 43
    return 38


def _semantic_words(value: str) -> list[str]:
    """Keep financial quantities with their unit when caption lines are split."""
    words = value.split()
    grouped: list[str] = []
    number = re.compile(r"^(?:[$€£]?\d[\d,.]*(?:%|x)?)$")
    units = {
        "billion", "million", "trillion", "thousand",
        "percent", "basis", "sessions", "weeks", "days",
    }
    index = 0
    while index < len(words):
        word = words[index]
        if (
            index + 1 < len(words)
            and number.match(word.rstrip(",;:"))
            and words[index + 1].rstrip(".,;:").lower() in units
        ):
            grouped.append(f"{word} {words[index + 1]}")
            index += 2
            continue
        grouped.append(word)
        index += 1
    return grouped


def _split_caption_part(value: str, target_chars: int = 150) -> list[str]:
    """Greedily wrap on semantic word boundaries instead of arbitrary midpoints."""
    chunks: list[str] = []
    current: list[str] = []
    for word in _semantic_words(value):
        candidate = " ".join(current + [word])
        if current and len(candidate) > target_chars:
            chunks.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        chunks.append(" ".join(current))
    glue_words = {"a", "an", "and", "against", "for", "not", "of", "or", "the", "to", "with"}
    for index in range(len(chunks) - 1):
        left = chunks[index].split()
        right = chunks[index + 1].split()
        carried: list[str] = []
        while left and left[-1].rstrip(",;:").lower() in glue_words:
            carried.insert(0, left.pop())
        if carried:
            chunks[index] = " ".join(left)
            chunks[index + 1] = " ".join(carried + right)
    return chunks


def sentence_chunks(value: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", value) if p.strip()]
    chunks: list[str] = []
    for part in parts:
        chunks.extend(_split_caption_part(part))
    return chunks[:5]


def evidence_numbers(value: str) -> list[str]:
    """Extract only quantities already present in the locked evidence beat."""
    found = re.findall(
        # Prefer the unit-bearing branch. Putting the bare-number branch first
        # lets the regex accept "34" before it ever considers "34 percent".
        r"(?:[$€£]\s*)?\d[\d,.]*\s*(?:%|percent|x|B|M|T|billion|million|trillion)"
        r"|(?:[$€£]\s*)?\d[\d,.]*",
        value,
        flags=re.IGNORECASE,
    )
    numbers: list[str] = []
    for raw in found:
        normalized = re.sub(r"\s+", " ", raw).strip()
        normalized = re.sub(r"\s+percent$", "%", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\s+billion$", "B", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\s+million$", "M", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\s+trillion$", "T", normalized, flags=re.IGNORECASE)
        normalized = re.sub(
            r"\s+([bmt])$",
            lambda match: match.group(1).upper(),
            normalized,
            flags=re.IGNORECASE,
        )
        if normalized and normalized not in numbers:
            numbers.append(normalized)
    return numbers[:3]


def evidence_metrics(value: str) -> list[dict[str, object]]:
    """Turn exact, source-bound figures into a compact comparison graphic."""
    metric_phrases = [
        ("gains on equity securities", "SECURITIES GAINS"),
        ("securities line", "SECURITIES LINE"),
        ("equity securities", "SECURITIES LINE"),
        ("operating cash flow", "OPERATING CASH FLOW"),
        ("capital expenditures", "CAPEX"),
        ("capital expenditure", "CAPEX"),
        ("operating income", "OPERATING INCOME"),
        ("net income", "NET INCOME"),
        ("free cash flow", "FREE CASH FLOW"),
        ("revenue", "REVENUE"),
        ("liquidity", "LIQUIDITY"),
        ("debt", "DEBT"),
        ("capex", "CAPEX"),
        ("margin", "MARGIN"),
        ("eps", "EPS"),
        ("cash", "CASH"),
    ]
    number_pattern = re.compile(
        r"(?:[$€£]\s*)?\d[\d,.]*\s*(?:%|percent|x|B|M|T|billion|million|trillion)",
        flags=re.IGNORECASE,
    )
    lowered = value.lower()
    phrase_positions = [
        (match.start(), match.end(), label)
        for phrase, label in metric_phrases
        for match in re.finditer(re.escape(phrase), lowered)
    ]
    movement_context = bool(re.search(
        r"\b(?:fell|fall|dropped|drop|declined|decline|slid|slide|rose|rise|"
        r"rallied|rally|gained|gain|jumped|jump|climbed|climb)\b",
        lowered,
    ))
    metrics: list[dict[str, object]] = []
    for index, match in enumerate(number_pattern.finditer(value)):
        raw = match.group(0)
        normalized = evidence_numbers(raw)
        if not normalized:
            continue
        # Financial prose usually introduces the line item before its amount
        # ("the securities line was $99.03B"). A nearest-distance match can
        # incorrectly bind that amount to the next comparison label
        # ("operating income"), making an accurate number visually false.
        preceding = [item for item in phrase_positions if item[1] <= match.start()]
        following = [item for item in phrase_positions if item[0] >= match.end()]
        # A line item may immediately follow its value ("$84.86B operating
        # cash flow"). Only that tight, adjectival form is allowed to override
        # the preceding subject. A later comparison ("$99.03B versus operating
        # income") must not relabel the first value.
        tight_following = [
            item for item in following if item[0] - match.end() <= 4
        ]
        if tight_following:
            label = min(tight_following, key=lambda item: item[0])[2]
        elif preceding:
            label = max(preceding, key=lambda item: item[1])[2]
        elif movement_context and "%" in normalized[0]:
            label = f"REPORTED MOVE {index + 1}"
        else:
            nearest = sorted(
                phrase_positions,
                key=lambda item: abs(item[0] - match.start()),
            )
            label = nearest[0][2] if nearest else f"REPORTED FIGURE {index + 1}"
        numeric_match = re.search(r"\d[\d,.]*", raw)
        numeric = float(numeric_match.group(0).replace(",", "")) if numeric_match else 0.0
        unit = raw.lower()
        if "trillion" in unit or re.search(r"\d\s*t\b", unit):
            numeric *= 1000.0
        elif "million" in unit or re.search(r"\d\s*m\b", unit):
            numeric /= 1000.0
        candidate = {
            "value": normalized[0],
            "label": label,
            "numeric": numeric,
            "isPercent": "%" in normalized[0],
        }
        if candidate["value"] not in {metric["value"] for metric in metrics}:
            metrics.append(candidate)
    return metrics[:3]


def evidence_headline(value: str, metrics: list[dict[str, object]]) -> str:
    """Describe the admitted comparison without inventing its source family."""
    lowered = value.lower()
    movement_context = bool(re.search(
        r"\b(?:fell|fall|dropped|drop|declined|decline|slid|slide|rose|rise|"
        r"rallied|rally|gained|gain|jumped|jump|climbed|climb)\b",
        lowered,
    ))
    if movement_context and metrics and all(metric.get("isPercent") for metric in metrics):
        return "The reported share-price moves"
    labels = {str(metric.get("label", "")) for metric in metrics}
    if "OPERATING CASH FLOW" in labels and "CAPEX" in labels:
        return "Cash flow versus capital spending"
    if any(
        label in labels
        for label in ("REVENUE", "OPERATING INCOME", "NET INCOME", "FREE CASH FLOW")
    ):
        return "The operating evidence"
    return "What the evidence shows"


def growth_metrics(value: str) -> list[dict[str, object]]:
    """Extract the two headline growth rates without confusing them with dollars."""
    labels = [
        ("operating cash flow", "OPERATING CASH FLOW"),
        ("operating income", "OPERATING INCOME"),
        ("net income", "NET INCOME"),
        ("revenue", "REVENUE"),
    ]
    lowered = value.lower()
    positions = [
        (match.start(), label)
        for phrase, label in labels
        for match in re.finditer(re.escape(phrase), lowered)
    ]
    result: list[dict[str, object]] = []
    for match in re.finditer(r"\d[\d,.]*\s*(?:%|percent)", value, re.IGNORECASE):
        numeric_match = re.search(r"\d[\d,.]*", match.group(0))
        numeric = float(numeric_match.group(0).replace(",", "")) if numeric_match else 0.0
        # Financial prose normally introduces the line item before its growth
        # rate ("revenue rose 24%"). A purely distance-based match can instead
        # bind that figure to the next clause ("net income ..."), producing a
        # confident-looking but false chart label.
        preceding = [item for item in positions if item[0] < match.start()]
        if preceding:
            label = max(preceding, key=lambda item: item[0])[1]
        else:
            nearest = sorted(positions, key=lambda item: abs(item[0] - match.start()))
            label = nearest[0][1] if nearest else "REPORTED GROWTH"
        rendered = re.sub(r"\s*percent", "%", match.group(0), flags=re.IGNORECASE)
        result.append({
            "value": rendered,
            "label": label,
            "numeric": numeric,
            "isPercent": True,
        })
    return result[:2]


def comparison_graphic(
    metrics: list[dict[str, object]],
    *,
    ratio_label: str = "",
) -> str:
    """Render a scale-accurate comparison instead of restating prose."""
    if not metrics:
        return ""
    max_metric = max(float(metric["numeric"]) for metric in metrics) or 1.0
    colors = ("#FF4D1F", "#2B4BF2", "#16150F")
    rows = "".join(
        '<div class="metric">'
        '<div class="metric-top"><span>' + html.escape(str(metric["label"])) + "</span>"
        '<b style="color:' + colors[index % len(colors)] + '">'
        + html.escape(str(metric["value"])) + "</b></div>"
        '<div class="metric-track"><i style="background:'
        + colors[index % len(colors)]
        + ";width:"
        + f'{max(7.0, 100.0 * float(metric["numeric"]) / max_metric):.1f}%'
        + '"></i></div></div>'
        for index, metric in enumerate(metrics)
    )
    ratio = (
        '<div class="ratio-badge">' + html.escape(ratio_label) + "</div>"
        if ratio_label
        else ""
    )
    return '<div class="evidence-chart">' + rows + ratio + "</div>"


def claims_for_beat(package: dict, beat: dict) -> str:
    """Return the exact claim statements admitted by a beat."""
    claim_ids = set(beat.get("claimIds", []))
    claims = package.get("editorial", {}).get("claims", [])
    return " ".join(
        str(claim.get("statement", ""))
        for claim in claims
        if claim.get("id") in claim_ids
    ).strip()


def locked_scene(
    *,
    ticker: str,
    date_chip: str,
    scene: str,
    eyebrow: str,
    headline: str,
    body: str,
    graphic: str,
    footer: str,
    accent: str = "#2B4BF2",
    headline_color: str = "#16150F",
    headline_size: int = 69,
) -> str:
    return fill(tpl("weekday-scene.html"), {
        "TICKER": html.escape(ticker),
        "DATE": html.escape(date_chip),
        "SCENE": html.escape(scene),
        "EYEBROW": html.escape(eyebrow),
        "HEADLINE": html.escape(headline),
        "BODY": html.escape(body),
        "GRAPHIC": graphic,
        "FOOTER": html.escape(footer),
        "ACCENT": accent,
        "HEADLINE_COLOR": headline_color,
        "HEADLINE_SIZE": headline_size,
        "NUMBER_COLUMNS": max(1, min(3, graphic.count('class="number"'))),
    })


def render_locked_weekday(
    package: dict,
    outdir: str,
    ticker: str,
    date_chip: str,
    beats: dict,
    signal: dict,
    lifecycle: dict,
    active_thesis: str,
    triangles: str,
    votes_for: int,
    votes_total: int,
) -> None:
    """Render the immutable six-scene weekday visual contract."""
    read = str(signal["label"]).upper()
    direction_color = "#2B4BF2" if signal["direction"] == "UP" else "#FF4D1F"
    headline_size = 76 if len(read) <= 18 else 65
    scene_specs: list[tuple[str, str]] = []

    hook = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="01 · THE READ",
        eyebrow="AMM THESIS MOVEMENT",
        headline=read,
        body=compact(beats["hook"]["text"], 115),
        graphic=direction_rail(signal["direction"], signal["strength"]),
        footer=f"{votes_for}/{votes_total} ANALYSTS SUPPORT · SOURCE-BOUND",
        accent=direction_color,
        headline_color=direction_color,
        headline_size=headline_size,
    )
    scene_specs.append(("weekday-01-hook.png", hook))

    change_text = compact(beats["change"]["text"], 132)
    change_claims = claims_for_beat(package, beats["change"])
    change_metrics = growth_metrics(change_claims or beats["change"]["text"])
    change = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="02 · WHAT CHANGED",
        eyebrow="TODAY'S NEW EVIDENCE",
        headline="Revenue grew. Net income jumped.",
        body=change_text,
        graphic=comparison_graphic(change_metrics),
        footer="ONE THESIS · NEW EVIDENCE DAILY",
        accent="#FF4D1F",
        headline_size=67,
    )
    scene_specs.append(("weekday-02-change.png", change))

    evidence_claims = claims_for_beat(package, beats["evidence"])
    metrics = evidence_metrics(evidence_claims or beats["evidence"]["text"])
    if not metrics:
        metrics = [{"value": "FILED", "label": "SOURCE-BOUND", "numeric": 1.0}]
    evidence_parts = sentence_chunks(beats["evidence"]["text"])
    evidence_headline_text = evidence_headline(
        evidence_claims or beats["evidence"]["text"],
        metrics,
    )
    evidence_body = compact(evidence_parts[0] if evidence_parts else "The evidence", 132)
    evidence = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="03 · THE EVIDENCE",
        eyebrow="NUMBERS BEFORE NARRATIVE",
        headline=evidence_headline_text,
        body=evidence_body,
        graphic=comparison_graphic(metrics),
        footer="EVERY NUMBER TRACES TO THE RELEASED DOSSIER",
        accent="#FF4D1F",
        headline_size=54,
    )
    scene_specs.append(("weekday-03-evidence.png", evidence))

    synthesis_claims = claims_for_beat(package, beats["thesis"])
    synthesis_metrics = [
        metric for metric in evidence_metrics(synthesis_claims or beats["thesis"]["text"])
        if not metric.get("isPercent")
    ][:2]
    synthesis_ratio = ""
    if len(synthesis_metrics) == 2 and float(synthesis_metrics[1]["numeric"]) > 0:
        ratio = float(synthesis_metrics[0]["numeric"]) / float(synthesis_metrics[1]["numeric"])
        synthesis_ratio = f"{ratio:.1f}× · REPORTED LINE VS OPERATING INCOME"
    synthesis = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="04 · THE SYNTHESIS",
        eyebrow="WHY THE EVIDENCE MATTERS",
        headline=active_thesis,
        body=compact(beats["thesis"]["text"], 128),
        graphic=comparison_graphic(synthesis_metrics, ratio_label=synthesis_ratio),
        footer=f"CURRENT READ · {read}",
        accent=direction_color,
        headline_size=title_size(active_thesis, True),
    )
    scene_specs.append(("weekday-04-thesis.png", synthesis))

    vote_detail = (
        f'{signal["votes"]["support"]} SUPPORT · '
        f'{signal["votes"]["oppose"]} OPPOSE · '
        f'{signal["votes"]["uncertain"]} UNCERTAIN'
    )
    council = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="05 · ANALYST CONFIDENCE",
        eyebrow="FIVE INDEPENDENT READS",
        headline=f"{votes_for}/{votes_total} SUPPORT",
        body=compact(beats["council"]["text"], 230),
        graphic=(
            '<div class="vote-row">' + triangles
            + '<div class="vote-copy">' + html.escape(vote_detail) + "</div></div>"
        ),
        footer="DISAGREEMENT IS SHOWN · NEVER SMOOTHED AWAY",
        accent="#FF4D1F",
        headline_size=72,
    )
    scene_specs.append(("weekday-05-council.png", council))

    close = locked_scene(
        ticker=ticker,
        date_chip=date_chip,
        scene="06 · FOLLOW THE EVIDENCE",
        eyebrow="THE THESIS MOVES WHEN THE EVIDENCE MOVES",
        headline="Track the thesis daily.",
        body="Fresh evidence. One standing thesis. Every change recorded.",
        graphic=(
            '<div class="cta"><div class="url">AFTERMARKETMOVERS.COM</div>'
            '<div class="promise">START FREE · BUILD YOUR AMM DESK</div></div>'
        ),
        footer="AFTERMARKETMOVERS.COM",
        accent="#FF4D1F",
        headline_color="#2B4BF2",
        headline_size=76,
    )
    scene_specs.append(("weekday-06-close.png", close))

    for filename, markup in scene_specs:
        render(markup, os.path.join(outdir, filename), transparent=True)

    plan = {
        "schema": "amm-short-visual-plan-v1",
        "templateVersion": package["editorial"]["templateVersion"],
        "layout": "weekday-locked-v2",
        "presenterShare": 0.35,
        "graphicsShare": 0.65,
        "scenes": [
            {"beat": beat, "file": filename}
            for beat, (filename, _) in zip(
                ("hook", "change", "evidence", "thesis", "council", "close"),
                scene_specs,
            )
        ],
        "spokenCta": beats["close"]["text"],
        "visualCta": "TRACK THE THESIS DAILY",
        "url": "AFTERMARKETMOVERS.COM",
        "cta": {
            "spoken": beats["close"]["text"],
            "visual": "TRACK THE THESIS DAILY",
            "url": "AFTERMARKETMOVERS.COM",
        },
    }
    with open(os.path.join(outdir, "weekday-visual-plan.json"), "w") as output:
        json.dump(plan, output, indent=2)
        output.write("\n")


def main(package_path: str, outdir: str) -> None:
    p = json.load(open(package_path))
    if p.get("schema") != "amm-short-episode-v1":
        raise ValueError("make_cards accepts only a validated amm-short-episode-v1 package")
    os.makedirs(outdir, exist_ok=True)
    ticker = p["dossier"]["ticker"]
    company_name = str(p.get("identity", {}).get("companyName") or ticker).strip()
    company_identity = ""
    if company_name.upper() != ticker.upper():
        company_identity = (
            '<p class="mono" style="margin:0;font-size:18px;line-height:1;'
            'font-weight:700;letter-spacing:2px;color:#6D6A62;">'
            + html.escape(company_name.upper()) + "</p>"
        )
    beats = p["editorial"]["beats"]
    signal = p["signal"]
    lifecycle = p["lifecycle"]
    direction = signal["direction"]
    strength = signal["strength"]
    read = signal["label"]
    is_weekend = p.get("format") == "weekend-recap"
    date_chip = (
        f'WEEKEND · {p["reportingCycle"]["publicationDate"]}'
        if is_weekend
        else p["dossier"]["date"]
    )
    movement = (
        reporting_cycle(p["reportingCycle"])
        if is_weekend
        else thesis_movement(lifecycle)
    )
    active_thesis = compact(lifecycle["canonicalSubjectPunchline"], 205)

    render(fill(tpl("hook.html"), {
        "TICKER": ticker,
        "CHANGE": compact(beats["change"]["text"], 230),
    }), os.path.join(outdir, "s-hook.png"))

    render(fill(tpl("presenter.html"), {
        "TICKER": ticker,
        "DATE": date_chip,
    }), os.path.join(outdir, "s-frame.png"), transparent=True)

    render(fill(tpl("split-frame.html"), {
        "TICKER": ticker,
        "DATE": date_chip,
    }), os.path.join(outdir, "split-frame.png"), transparent=True)

    render(fill(tpl("split-hook.html"), {
        "CHANGE": compact(beats["change"]["text"], 235),
    }), os.path.join(outdir, "split-hook.png"), transparent=True)

    render(fill(tpl("meter.html"), {
        "DATE_CHIP": date_chip,
        "READ": read,
        "ACTIVE_THESIS": active_thesis,
        "ACTIVE_THESIS_SIZE": title_size(active_thesis, True),
        "OPENED_DATE": lifecycle["openedDate"],
        "MOVEMENT": movement,
        "STATUS": str(lifecycle["status"]).upper(),
        "MECHANISM": compact(beats["thesis"]["text"], 185),
    }), os.path.join(outdir, "s-meter.png"))

    render(fill(tpl("split-meter.html"), {
        "ACTIVE_THESIS": active_thesis,
        "ACTIVE_THESIS_SIZE": title_size(active_thesis, False),
        "OPENED_DATE": lifecycle["openedDate"],
        "MOVEMENT": movement,
        "STATUS": str(lifecycle["status"]).upper(),
        "MECHANISM": compact(beats["thesis"]["text"], 175),
    }), os.path.join(outdir, "split-meter.png"), transparent=True)

    votes_for = signal["votes"]["support"]
    votes_total = sum(signal["votes"].values())
    tris = TRI_FULL * votes_for + TRI_HOLLOW * (votes_total - votes_for)
    if (
        not is_weekend
        and p.get("editorial", {}).get("templateVersion") == "amm-weekday-locked-v3"
    ):
        render_locked_weekday(
            p,
            outdir,
            ticker,
            date_chip,
            beats,
            signal,
            lifecycle,
            active_thesis,
            tris,
            votes_for,
            votes_total,
        )
    render(fill(tpl("vote.html"), {
        "DATE_CHIP": date_chip, "TRIANGLES": tris,
        "VOTE": f'{votes_for}/{votes_total} AGREE',
        "DISSENT": compact(beats["council"]["text"], 230),
    }), os.path.join(outdir, "s-vote.png"))

    render(fill(tpl("split-vote.html"), {
        "TRIANGLES": tris,
        "VOTE": f'{votes_for}/{votes_total} AGREE',
        "DISSENT": compact(beats["council"]["text"], 225),
        "STATUS": str(lifecycle["status"]).upper(),
    }), os.path.join(outdir, "split-vote.png"), transparent=True)

    render(fill(tpl("end.html"), {
        "MASCOT": asset_data_uri(os.path.join(HERE, "..", "..", "public", "amm-fox.png")),
    }), os.path.join(outdir, "s-end.png"))
    render(fill(tpl("split-end.html"), {}),
           os.path.join(outdir, "split-end.png"), transparent=True)

    story_caps = sentence_chunks(beats["evidence"]["text"])
    caps = [beats["hook"]["text"]] + story_caps
    for i, text in enumerate(caps, start=1):
        render(fill(tpl("caption.html"), {"TEXT": text.upper().replace("\n", "<br>")}),
               os.path.join(outdir, f"cap{i}.png"), transparent=True)
        is_hook = i == 1
        if is_hook:
            uncertain = signal["votes"]["uncertain"]
            oppose = signal["votes"]["oppose"]
            vote_detail = (
                f"{votes_for} SUPPORT · {uncertain} UNCERTAIN"
                + (f" · {oppose} OPPOSE" if oppose else "")
            )
            render(fill(tpl("split-open.html"), {
                "TICKER": ticker,
                "COMPANY_IDENTITY": company_identity,
                "READ": read,
                "TRIANGLES": tris,
                "VOTE": f"{votes_for}/{votes_total} SUPPORT",
                "VOTE_DETAIL": vote_detail,
                "STATUS": str(lifecycle["status"]).upper(),
                "OBSERVATION": lifecycle["observationIndex"],
            }), os.path.join(outdir, f"split-cap{i}.png"), transparent=True)
        else:
            render(fill(tpl("split-caption.html"), {
                "LABEL": "EVIDENCE",
                "COUNT": f"{i - 1}/{len(story_caps)}",
                "TEXT": compact(text, 220),
            }), os.path.join(outdir, f"split-cap{i}.png"), transparent=True)
    weights = [max(1, len(text.split())) for text in story_caps]
    with open(os.path.join(outdir, "caption-weights.json"), "w") as f:
        json.dump({"weights": weights, "count": len(story_caps)}, f)
    with open(os.path.join(outdir, "caption-copy.json"), "w") as f:
        json.dump({"captions": story_caps}, f, indent=2)
    print(f"cards → {outdir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
