#!/usr/bin/env python3
"""Generate AMM's deterministic, sample-free ambient music bed."""

import array
import math
import sys
import wave

SAMPLE_RATE = 44_100
CHORD_SECONDS = 8.0
MIN_SHORT_SECONDS = 34.0
MAX_SHORT_SECONDS = 75.0
CHORDS = (
    (130.81, 164.81, 196.00, 246.94),  # Cmaj7
    (110.00, 130.81, 164.81, 196.00),  # Am7
    (87.31, 130.81, 164.81, 220.00),   # Fmaj7
    (98.00, 146.83, 196.00, 220.00),   # Gsus
)
PLUCKS = (392.00, 329.63, 261.63, 329.63, 440.00, 392.00, 329.63, 293.66)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def chord_sample(chord: tuple[float, ...], time: float, phase: float) -> float:
    total = 0.0
    for index, frequency in enumerate(chord):
        total += (
            math.sin(2 * math.pi * frequency * time + phase * index)
            + 0.16 * math.sin(2 * math.pi * frequency * 2 * time + phase)
        ) / (index + 2)
    return total / 1.8


def main(duration_value: str, output_path: str) -> None:
    duration = float(duration_value)
    # Weekday speech is targeted at 36–46 seconds, but natural avatar delivery
    # may land up to 2 seconds under the target without losing any words.
    # Weekend reviews can remain longer. Keep one deterministic bed generator
    # for both formats and reject genuinely short/long output.
    if not MIN_SHORT_SECONDS <= duration <= MAX_SHORT_SECONDS:
        raise ValueError(f"music duration {duration:.2f}s is outside the Shorts contract")
    frames = int(duration * SAMPLE_RATE)
    output = array.array("h")

    for frame in range(frames):
        time = frame / SAMPLE_RATE
        chord_position = time / CHORD_SECONDS
        chord_index = int(chord_position) % len(CHORDS)
        next_index = (chord_index + 1) % len(CHORDS)
        within = time % CHORD_SECONDS
        blend = smoothstep((within - 6.5) / 1.5)

        left_pad = (
            chord_sample(CHORDS[chord_index], time, 0.09) * (1 - blend)
            + chord_sample(CHORDS[next_index], time, 0.09) * blend
        )
        right_pad = (
            chord_sample(CHORDS[chord_index], time, 0.21) * (1 - blend)
            + chord_sample(CHORDS[next_index], time, 0.21) * blend
        )

        pulse_position = time % 2.0
        pluck_index = int(time / 2.0) % len(PLUCKS)
        pluck_envelope = math.exp(-3.3 * pulse_position)
        pluck = (
            math.sin(2 * math.pi * PLUCKS[pluck_index] * time)
            + 0.22 * math.sin(2 * math.pi * PLUCKS[pluck_index] * 2 * time)
        ) * pluck_envelope

        heartbeat = math.sin(2 * math.pi * 55 * time) * math.exp(-11 * (time % 1.0))
        fade = min(1.0, time / 1.5, (duration - time) / 1.8)
        left = (0.23 * left_pad + 0.10 * pluck + 0.025 * heartbeat) * fade
        right = (0.23 * right_pad + 0.09 * pluck + 0.025 * heartbeat) * fade
        output.extend((
            int(max(-1.0, min(1.0, left)) * 32767),
            int(max(-1.0, min(1.0, right)) * 32767),
        ))

    with wave.open(output_path, "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(output.tobytes())
    print(f"original AMM music → {output_path} ({duration:.2f}s)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
