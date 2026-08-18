#!/usr/bin/env python3
"""Provision, download, validate, export, and plot sauna session logs."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import statistics
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

import serial

HEADER_V1 = struct.Struct("<8sHHIIIhBBhhhIII")
HEADER_V2 = struct.Struct("<8sHHIIIhBBhhhIIIIBBBBI")
# Backward-compatible name used by older fixtures and external scripts.
HEADER_BASE = HEADER_V1
DESCRIPTOR = struct.Struct("<8sh")
CRC = struct.Struct("<I")
BLOCK = struct.Struct("<IIHHI")
RECORD_V1 = struct.Struct("<i8hB")
RECORD_V2 = struct.Struct("<i8hBhH")
RECORD = RECORD_V1
FOOTER = struct.Struct("<IB3xIiI")
HEADER_MAGIC = b"SAUNLOG1"
BLOCK_MAGIC = 0x314B4C42
FOOTER_MAGIC = 0x31444E45
FINISH_REASONS = {1: "normal_cooling", 2: "max_duration", 3: "storage_full"}
RESET_REASONS = {
    1: "power_on", 2: "external", 3: "software", 4: "panic",
    5: "interrupt_watchdog", 6: "task_watchdog", 7: "other_watchdog",
    8: "deep_sleep", 9: "brownout", 10: "sdio",
}
CONTINUATION_KINDS = {
    0: "none",
    1: "max_duration",
    2: "probable_power_restore",
    3: "max_duration_sample_anchored",
}
RTC_SOURCES = {0: "internal_rc", 1: "external_32k_xtal", 2: "internal_8m_div256"}


@dataclass(frozen=True)
class Sensor:
    rom: str
    relative_height_cm: int


@dataclass(frozen=True)
class Sample:
    relative_seconds: int
    temperatures_c: tuple[float | None, ...]
    chip_temperature_c: float | None = None
    status_flags: int = 0


@dataclass
class Session:
    session_id: int
    sample_interval_ms: int
    sensors: list[Sensor]
    samples: list[Sample]
    finalized: bool
    finish_reason: str
    warnings: list[str]
    continuation_of: int = 0
    version: int = 1
    boot_id: int = 0
    reset_reason: str = "unknown"
    continuation_kind: str = "none"
    continuation_delay_seconds: int = 0
    initial_rtc_source: str = "unknown"
    initial_rtc_hz: int = 0


def parse_session(data: bytes) -> Session:
    if len(data) < HEADER_V1.size + 8 * DESCRIPTOR.size + CRC.size:
        raise ValueError("file is shorter than a session header")
    magic, version, header_size = struct.unpack_from("<8sHH", data)
    header_struct = HEADER_V1 if version == 1 else HEADER_V2 if version == 2 else None
    if header_struct is None:
        raise ValueError("unsupported session version")
    if len(data) < header_struct.size + 8 * DESCRIPTOR.size + CRC.size:
        raise ValueError("file is shorter than a session header")
    values = header_struct.unpack_from(data)
    magic, version, header_size = values[:3]
    if magic != HEADER_MAGIC:
        raise ValueError("unsupported session magic or version")
    sensor_count = values[7]
    minimum_header_size = header_struct.size + sensor_count * DESCRIPTOR.size + CRC.size
    if header_size > len(data) or header_size < minimum_header_size:
        raise ValueError("invalid header size")
    expected_crc = CRC.unpack_from(data, header_size - CRC.size)[0]
    if zlib.crc32(data[: header_size - CRC.size]) & 0xFFFFFFFF != expected_crc:
        raise ValueError("header CRC mismatch")
    session_id, sample_interval_ms = values[3], values[4]
    continuation_of = values[14]
    if sensor_count != 8:
        raise ValueError(f"expected 8 sensors, found {sensor_count}")
    sensors = []
    boot_id = values[15] if version == 2 else 0
    reset_reason = RESET_REASONS.get(values[16], f"reason_{values[16]}") if version == 2 else "unknown"
    continuation_kind = CONTINUATION_KINDS.get(values[17], f"kind_{values[17]}") if version == 2 else ("max_duration" if continuation_of else "none")
    continuation_delay_seconds = values[19] if version == 2 else 0
    initial_rtc_source = RTC_SOURCES.get(values[18], f"source_{values[18]}") if version == 2 else "unknown"
    initial_rtc_hz = values[20] if version == 2 else 0
    offset = header_struct.size
    for _ in range(sensor_count):
        rom, height = DESCRIPTOR.unpack_from(data, offset)
        sensors.append(Sensor(rom.hex().upper(), height))
        offset += DESCRIPTOR.size

    samples: list[Sample] = []
    warnings: list[str] = []
    finalized = False
    finish_reason = "interrupted"
    offset = header_size
    expected_sequence = 0
    record_struct = RECORD_V1 if version == 1 else RECORD_V2
    while offset < len(data):
        if len(data) - offset >= FOOTER.size:
            footer = FOOTER.unpack_from(data, offset)
            if footer[0] == FOOTER_MAGIC:
                footer_bytes = data[offset : offset + FOOTER.size]
                if zlib.crc32(footer_bytes[:-4]) & 0xFFFFFFFF != footer[-1]:
                    warnings.append("invalid footer CRC; treating session as interrupted")
                else:
                    finalized = True
                    finish_reason = FINISH_REASONS.get(footer[1], f"reason_{footer[1]}")
                    if footer[2] != len(samples):
                        warnings.append(
                            f"footer says {footer[2]} records; decoded {len(samples)}"
                        )
                break
        if len(data) - offset < BLOCK.size:
            warnings.append("ignored torn trailing block header")
            break
        magic, sequence, count, payload_bytes, payload_crc = BLOCK.unpack_from(data, offset)
        if magic != BLOCK_MAGIC or count > 60 or payload_bytes != count * record_struct.size:
            warnings.append("ignored invalid trailing block header")
            break
        payload_start = offset + BLOCK.size
        payload_end = payload_start + payload_bytes
        if payload_end > len(data):
            warnings.append("ignored torn trailing block payload")
            break
        payload = data[payload_start:payload_end]
        if zlib.crc32(payload) & 0xFFFFFFFF != payload_crc:
            warnings.append("ignored trailing block with CRC mismatch")
            break
        if sequence != expected_sequence:
            warnings.append(f"block sequence jumped from {expected_sequence} to {sequence}")
        expected_sequence = sequence + 1
        for index in range(count):
            record = record_struct.unpack_from(payload, index * record_struct.size)
            valid_mask = record[9]
            temperatures = tuple(
                value / 100.0 if valid_mask & (1 << sensor_index) else None
                for sensor_index, value in enumerate(record[1:9])
            )
            chip_temperature = record[10] / 100.0 if version == 2 and record[11] & 1 else None
            status_flags = record[11] if version == 2 else 0
            samples.append(Sample(record[0], temperatures, chip_temperature, status_flags))
        offset = payload_end
    return Session(
        session_id, sample_interval_ms, sensors, samples, finalized, finish_reason,
        warnings, continuation_of, version, boot_id, reset_reason,
        continuation_kind, continuation_delay_seconds, initial_rtc_source,
        initial_rtc_hz
    )


class Device:
    def __init__(self, port: str, baud: int = 115200):
        self.serial = serial.Serial(port, baud, timeout=2)
        time.sleep(1)
        self.serial.reset_input_buffer()

    def close(self) -> None:
        self.serial.close()

    def command(self, text: str, until: str | None = None, timeout: float = 8) -> list[str]:
        self.serial.write((text + "\n").encode())
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        while time.monotonic() < deadline:
            line = self.serial.readline().decode(errors="replace").strip()
            if not line or line.startswith("TELEM "):
                continue
            lines.append(line)
            if until is None or line.startswith(until) or line.startswith("LOG_ERROR"):
                return lines
        raise TimeoutError(f"timed out waiting for response to {text!r}")

    def download(self, session_id: int) -> bytes:
        self.serial.write(f"LOG GET {session_id}\n".encode())
        deadline = time.monotonic() + 30
        content = bytearray()
        expected_size = expected_crc = None
        while time.monotonic() < deadline:
            line = self.serial.readline().decode(errors="replace").strip()
            if not line or line.startswith("TELEM "):
                continue
            if line.startswith("LOG_ERROR"):
                raise RuntimeError(line)
            if line.startswith("LOG_DATA_BEGIN"):
                match = re.search(r"bytes=(\d+) crc32=([0-9A-Fa-f]{8})", line)
                if not match:
                    raise RuntimeError(f"invalid download header: {line}")
                expected_size, expected_crc = int(match.group(1)), int(match.group(2), 16)
            elif line.startswith("LOG_DATA "):
                content.extend(bytes.fromhex(line[9:]))
            elif line.startswith("LOG_DATA_END"):
                break
        else:
            raise TimeoutError("download did not finish")
        if expected_size is None or len(content) != expected_size:
            raise RuntimeError(f"download size mismatch: got {len(content)}, expected {expected_size}")
        actual_crc = zlib.crc32(content) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise RuntimeError(f"download CRC mismatch: {actual_crc:08X} != {expected_crc:08X}")
        return bytes(content)

    def download_coredump(self) -> bytes:
        self.serial.write(b"LOG CRASH GET\n")
        deadline = time.monotonic() + 30
        content = bytearray()
        expected_size = expected_crc = None
        while time.monotonic() < deadline:
            line = self.serial.readline().decode(errors="replace").strip()
            if not line or line.startswith("TELEM "):
                continue
            if line.startswith("LOG_ERROR"):
                raise RuntimeError(line)
            if line.startswith("LOG_CRASH_BEGIN"):
                match = re.search(r"bytes=(\d+) crc32=([0-9A-Fa-f]{8})", line)
                if not match:
                    raise RuntimeError(f"invalid coredump header: {line}")
                expected_size, expected_crc = int(match.group(1)), int(match.group(2), 16)
            elif line.startswith("LOG_CRASH_DATA "):
                content.extend(bytes.fromhex(line[15:]))
            elif line.startswith("LOG_CRASH_END"):
                break
        else:
            raise TimeoutError("coredump download did not finish")
        if expected_size is None or len(content) != expected_size:
            raise RuntimeError(f"coredump size mismatch: got {len(content)}, expected {expected_size}")
        actual_crc = zlib.crc32(content) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise RuntimeError(f"coredump CRC mismatch: {actual_crc:08X} != {expected_crc:08X}")
        return bytes(content)


def export_csv(session: Session, destination: Path) -> None:
    with destination.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(["relative_seconds", *[f"probe_{index}_c" for index in range(1, 9)],
                         "chip_temperature_c", "status_flags", "rtc_slow_clock_source"])
        for sample in session.samples:
            writer.writerow(
                [sample.relative_seconds, *["" if value is None else f"{value:.2f}" for value in sample.temperatures_c],
                 "" if sample.chip_temperature_c is None else f"{sample.chip_temperature_c:.2f}",
                 f"0x{sample.status_flags:04X}",
                 "external_32k_xtal" if sample.status_flags & 2 else "internal_or_fallback"]
            )


def session_report(session: Session) -> dict[str, object]:
    probes = []
    for index, sensor in enumerate(session.sensors):
        values = [(sample.relative_seconds, sample.temperatures_c[index]) for sample in session.samples]
        valid = [(second, value) for second, value in values if value is not None]
        crossings = {}
        for threshold in (40, 60, 80, 100):
            crossing = next((second for second, value in valid if value >= threshold), None)
            crossings[str(threshold)] = crossing
        rates = []
        for (first_second, first_value), (second_second, second_value) in zip(valid, valid[1:]):
            elapsed = second_second - first_second
            if elapsed > 0:
                rates.append((second_value - first_value) * 60.0 / elapsed)
        probes.append(
            {
                "position": index + 1,
                "rom": sensor.rom,
                "relative_height_cm": sensor.relative_height_cm,
                "valid_samples": len(valid),
                "missing_samples": len(session.samples) - len(valid),
                "minimum_c": min((value for _, value in valid), default=None),
                "maximum_c": max((value for _, value in valid), default=None),
                "mean_c": statistics.fmean(value for _, value in valid) if valid else None,
                "maximum_heating_rate_c_per_min": max(rates, default=None),
                "maximum_cooling_rate_c_per_min": min(rates, default=None),
                "threshold_crossing_seconds": crossings,
            }
        )
    gradients = []
    vertical_span_m = abs(session.sensors[-1].relative_height_cm - session.sensors[0].relative_height_cm) / 100.0
    if vertical_span_m:
        for sample in session.samples:
            top, bottom = sample.temperatures_c[0], sample.temperatures_c[-1]
            if top is not None and bottom is not None:
                gradients.append((top - bottom) / vertical_span_m)
    report = {
        "session_id": session.session_id,
        "format_version": session.version,
        "boot_id": session.boot_id or None,
        "reset_reason": session.reset_reason,
        "continuation_of": session.continuation_of or None,
        "continuation_kind": session.continuation_kind,
        "continuation_delay_seconds": session.continuation_delay_seconds or None,
        "initial_rtc_source": session.initial_rtc_source,
        "initial_rtc_hz": session.initial_rtc_hz or None,
        "state": "finalized" if session.finalized else "interrupted",
        "finish_reason": session.finish_reason,
        "sample_count": len(session.samples),
        "duration_seconds": session.samples[-1].relative_seconds - session.samples[0].relative_seconds if len(session.samples) > 1 else 0,
        "warnings": session.warnings,
        "chip_temperature_c": {
            "minimum": min((s.chip_temperature_c for s in session.samples if s.chip_temperature_c is not None), default=None),
            "maximum": max((s.chip_temperature_c for s in session.samples if s.chip_temperature_c is not None), default=None),
        },
        "rtc_xtal_fallback_observed": any(s.status_flags & 4 for s in session.samples),
        "vertical_gradient_c_per_m": {
            "minimum": min(gradients, default=None),
            "maximum": max(gradients, default=None),
            "mean": statistics.fmean(gradients) if gradients else None,
        },
        "probes": probes,
    }
    from sauna_analysis import analyze_run, build_run
    report["thermal_analysis"] = analyze_run(build_run([session]))
    return report


def export_html(session: Session, destination: Path) -> None:
    from sauna_analysis import build_run, export_run_html
    export_run_html(build_run([session]), destination)


def discover_run(input_path: Path, include_chain: bool = True) -> list[Session]:
    selected = parse_session(input_path.read_bytes())
    if not include_chain:
        return [selected]
    candidates: dict[int, Session] = {}
    for path in input_path.parent.glob("*.slog"):
        try:
            session = parse_session(path.read_bytes())
        except (OSError, ValueError):
            continue
        candidates.setdefault(session.session_id, session)
    candidates[selected.session_id] = selected
    root = selected
    seen = {root.session_id}
    while root.continuation_of and root.continuation_of in candidates:
        root = candidates[root.continuation_of]
        if root.session_id in seen:
            raise ValueError("continuation chain contains a cycle")
        seen.add(root.session_id)
    ordered = [root]
    while True:
        successors = sorted(
            (session for session in candidates.values()
             if session.continuation_of == ordered[-1].session_id and session.session_id not in seen),
            key=lambda session: session.session_id,
        )
        if not successors:
            break
        if len(successors) > 1:
            raise ValueError(f"session {ordered[-1].session_id} has multiple continuation branches")
        ordered.append(successors[0])
        seen.add(successors[0].session_id)
    return ordered


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyACM0")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "list"):
        sub.add_parser(name)
    format_parser = sub.add_parser("format")
    format_parser.add_argument("--yes", action="store_true", required=True)
    download = sub.add_parser("download")
    download.add_argument("session_id", type=int)
    download.add_argument("output", type=Path)
    delete = sub.add_parser("delete")
    delete.add_argument("session_id", type=int)
    crash_download = sub.add_parser("crash-download")
    crash_download.add_argument("output", type=Path)
    sub.add_parser("crash-erase")
    for name in ("export", "report"):
        command = sub.add_parser(name)
        command.add_argument("input", type=Path)
        if name != "report": command.add_argument("output", type=Path)
    plot = sub.add_parser("plot")
    plot.add_argument("input", type=Path)
    plot.add_argument("output", type=Path)
    plot.add_argument("--no-chain", action="store_true")
    compare = sub.add_parser("compare")
    compare.add_argument("inputs", nargs="+", type=Path)
    compare.add_argument("--output", "-o", required=True, type=Path)
    compare.add_argument("--no-chain", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command in {"export", "report"}:
        session = parse_session(args.input.read_bytes())
        if args.command == "export": export_csv(session, args.output)
        else: print(json.dumps(session_report(session), indent=2))
        for warning in session.warnings: print(f"warning: {warning}", file=sys.stderr)
        return 0
    if args.command == "plot":
        from sauna_analysis import build_run, export_run_html
        sessions = discover_run(args.input, not args.no_chain)
        export_run_html(build_run(sessions), args.output)
        print(f"wrote interactive report for {len(sessions)} segment(s) to {args.output}")
        return 0
    if args.command == "compare":
        from sauna_analysis import build_run, export_comparison_html
        runs = [build_run(discover_run(path, not args.no_chain)) for path in args.inputs]
        roots = [run.sessions[0].session_id for run in runs]
        if len(set(roots)) != len(roots):
            raise ValueError("the same continuation chain was selected more than once")
        export_comparison_html(runs, args.output)
        print(f"wrote comparison of {len(runs)} runs to {args.output}")
        return 0
    device = Device(args.port)
    try:
        if args.command == "status": lines = device.command("LOG STATUS", "LOG_STATUS")
        elif args.command == "list": lines = device.command("LOG LIST", "LOG_LIST_END")
        elif args.command == "format": lines = device.command("LOG FORMAT YES", "LOG_FORMAT")
        elif args.command == "delete": lines = device.command(f"LOG DELETE {args.session_id}", "LOG_DELETE")
        elif args.command == "crash-erase": lines = device.command("LOG CRASH ERASE YES", "LOG_CRASH_ERASE")
        elif args.command == "crash-download":
            data = device.download_coredump()
            args.output.write_bytes(data)
            print(f"downloaded {len(data)} coredump bytes to {args.output}")
            return 0
        elif args.command == "download":
            data = device.download(args.session_id)
            session = parse_session(data)
            args.output.write_bytes(data)
            print(f"downloaded session {session.session_id}: {len(session.samples)} valid records to {args.output}")
            return 0
        else: raise AssertionError(args.command)
        print("\n".join(lines))
    finally:
        device.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
