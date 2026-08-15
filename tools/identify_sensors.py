#!/usr/bin/env python3
"""Interactively map DS18B20 ROM addresses to physical heights."""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

import serial


READING = re.compile(
    r"rom=(?P<rom>[0-9A-Fa-f]{16}) temperature_c=(?P<temperature>-?\d+(?:\.\d+)?)"
)
SAMPLE_START = "sample sensors="
EXPECTED_SENSORS = 8
BASELINE_SAMPLES = 5
MINIMUM_RISE_C = 3.0
WINNER_MARGIN_C = 1.0


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Identify warmed DS18B20 probes and save their linear order."
    )
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--baud", default=115200, type=int)
    parser.add_argument("--output", default="sensor-map.json", type=Path)
    return parser.parse_args()


def read_sample(port: serial.Serial) -> dict[str, float]:
    sample: dict[str, float] = {}
    while True:
        line = port.readline().decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line.startswith(SAMPLE_START) and sample:
            return sample
        match = READING.search(line)
        if match:
            sample[match.group("rom").upper()] = float(match.group("temperature"))


def learn_baselines(port: serial.Serial) -> dict[str, float]:
    history: dict[str, list[float]] = {}
    print(f"Learning ambient baselines from {BASELINE_SAMPLES} complete samples...")
    complete = 0
    while complete < BASELINE_SAMPLES:
        sample = read_sample(port)
        if len(sample) != EXPECTED_SENSORS:
            print(f"  ignored incomplete sample ({len(sample)}/{EXPECTED_SENSORS})")
            continue
        for rom, temperature in sample.items():
            history.setdefault(rom, []).append(temperature)
        complete += 1
        print(f"  baseline sample {complete}/{BASELINE_SAMPLES}")
    return {rom: statistics.median(values) for rom, values in history.items()}


def detect_warmed_sensor(
    port: serial.Serial, baselines: dict[str, float], already_mapped: set[str]
) -> tuple[str, float, float]:
    while True:
        sample = read_sample(port)
        rises = sorted(
            (
                (temperature - baselines[rom], rom, temperature)
                for rom, temperature in sample.items()
                if rom in baselines and rom not in already_mapped
            ),
            reverse=True,
        )
        if not rises:
            continue

        best_rise, best_rom, best_temperature = rises[0]
        second_rise = rises[1][0] if len(rises) > 1 else 0.0
        print(
            f"\r  strongest change: {best_rom} {best_temperature:6.2f} C "
            f"(delta {best_rise:+5.2f} C)",
            end="",
            flush=True,
        )
        if (
            best_rise >= MINIMUM_RISE_C
            and best_rise - second_rise >= WINNER_MARGIN_C
        ):
            print()
            return best_rom, best_temperature, best_rise


def save_mapping(path: Path, mappings: list[dict[str, object]]) -> None:
    document = {
        "device": "sauna-column-1",
        "one_wire_pin": "D2",
        "reference_end": "opposite_esp32",
        "position_direction": "toward_esp32",
        "sensors": mappings,
    }
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = arguments()
    mappings: list[dict[str, object]] = []

    try:
        with serial.Serial(args.port, args.baud, timeout=4) as port:
            time.sleep(1)
            port.reset_input_buffer()
            baselines = learn_baselines(port)
            print(f"Found {len(baselines)} stable sensor baselines.")

            print(
                "Starting at the end opposite the ESP32. "
                "Positions increase toward the ESP32."
            )
            while len(mappings) < len(baselines):
                position = len(mappings) + 1
                input(
                    f"\nPlace probe {position} from the end opposite the ESP32 "
                    "in hot water, "
                    "then press Enter... "
                )
                rom, temperature, rise = detect_warmed_sensor(
                    port, baselines, {str(item["rom"]) for item in mappings}
                )
                print(
                    f"Identified position {position}: {rom} "
                    f"({temperature:.2f} C, rise {rise:.2f} C)"
                )
                mappings.append(
                    {"position_from_reference_end": position, "rom": rom}
                )
                save_mapping(args.output, mappings)
                print(f"Saved {args.output}")
                if len(mappings) < len(baselines):
                    input(
                        "Remove the probe from the water, move to the next probe, "
                        "then press Enter to continue... "
                    )

    except serial.SerialException as error:
        print(f"Serial error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped.")

    if mappings:
        save_mapping(args.output, mappings)
        print(f"Mapping contains {len(mappings)} sensor(s): {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
