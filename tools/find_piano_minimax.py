#!/usr/bin/env python3
"""Search one playback anchor per sample/octave for the smallest worst key error."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

import analyze_pitch as pitch


DEFAULT_GROUPS = (
    ("mi", 5),
    ("mi", 6),
    ("dingdongji_ding", 3),
    ("dingdongji_ding", 6),
    ("dingdongji_ji", 6),
)


def measure(
    samples: np.ndarray,
    sample_rate: int,
    octave_start: int,
    playback_reference_midi: float,
) -> tuple[float, float, float]:
    errors = []
    base_midi = (octave_start + 1) * 12
    for interval in pitch.PIANO_SCALE_INTERVALS:
        target_midi = base_midi + interval
        rate = 2.0 ** ((target_midi - playback_reference_midi) / 12.0)
        rendered = pitch.playback_rate_resample(samples, rate)
        analysis = pitch.analyze_transposed_pitch(
            rendered,
            sample_rate,
            target_midi,
        )
        errors.append((analysis.anchor_midi - target_midi) * 100.0)
    return max(abs(error) for error in errors), min(errors), max(errors)


def search_group(
    samples: np.ndarray,
    sample_rate: int,
    octave_start: int,
    source_anchor_midi: float,
) -> tuple[float, float, float, float]:
    center = source_anchor_midi
    radius = 0.5
    best = (float("inf"), center, 0.0, 0.0)
    for _ in range(3):
        for reference in np.linspace(center - radius, center + radius, 17):
            worst, low, high = measure(
                samples,
                sample_rate,
                octave_start,
                float(reference),
            )
            candidate = (worst, float(reference), low, high)
            if candidate < best:
                best = candidate
        center = best[1]
        radius /= 4.0
    return best[1], best[0], best[2], best[3]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "audio",
    )
    args = parser.parse_args()
    for sample_name, octave_start in DEFAULT_GROUPS:
        relative_path = pitch.SAMPLE_SOURCE_FILES.get(
            sample_name,
            Path(f"{sample_name}.wav"),
        )
        sample_rate, samples = pitch.read_pcm16_wav(args.audio_dir / relative_path)
        source = pitch.analyze_pitch(samples, sample_rate)
        reference, worst, low, high = search_group(
            samples,
            sample_rate,
            octave_start,
            source.anchor_midi,
        )
        print(
            f"{sample_name}/C{octave_start}: {reference:.14f} "
            f"worst={worst:.3f} cents range={low:.3f}..{high:.3f}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
