#!/usr/bin/env python3
"""Interactively commission the eight ordered sauna temperature probes."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import serial

from commissioning_protocol import (
    EXPECTED_SENSORS,
    GEOMETRY_ID,
    CommissioningClient,
    CommissioningLease,
    DeviceError,
    ProbeConfiguration,
    ProtocolError,
    ScanResult,
    one_added_rom,
    require_active_generation,
    require_compatible_device,
    select_warmed_probe,
    strongest_warming,
)


BASELINE_SAMPLES = 5
REBOOT_VERIFY_TIMEOUT_SECONDS = 20.0


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Assign eight DS18B20 ROM addresses to positions from the top/farthest "
            "probe toward the ESP32."
        )
    )
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--baud", default=115200, type=int)
    parser.add_argument("--output", default="sensor-map.json", type=Path)
    parser.add_argument(
        "--method",
        choices=("connect", "warm"),
        default="connect",
        help=(
            "connect probes one at a time (default), or warm one probe at a time "
            "after an assembled harness is connected"
        ),
    )
    return parser.parse_args()


def mapping_entries(roms: list[str]) -> list[dict[str, object]]:
    return [
        {
            "position_from_reference_end": position,
            "relative_height_cm": -20 * (position - 1),
            "rom": rom,
        }
        for position, rom in enumerate(roms, 1)
    ]


def pending_mapping_path(path: Path) -> Path:
    """Return a visible sidecar path that cannot replace the verified map."""

    if path.suffix:
        return path.with_name(f"{path.stem}.pending{path.suffix}")
    return path.with_name(f"{path.name}.pending")


def pending_mapping_matches(path: Path, roms: list[str]) -> bool:
    """Return whether a saved partial map is the same complete ordered map."""

    if not path.exists():
        return False
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        if (
            document.get("schema_version") != 1
            or document.get("geometry") != GEOMETRY_ID
        ):
            return False
        saved = [sensor["rom"] for sensor in document["sensors"]]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False
    return saved == roms


def save_mapping(
    path: Path,
    roms: list[str],
    configuration: ProbeConfiguration | None = None,
) -> None:
    """Atomically preserve partial progress or the verified final mapping."""

    document: dict[str, object] = {
        "schema_version": 1,
        "device": "sauna-column-1",
        "one_wire_pin": "D2",
        "geometry": GEOMETRY_ID,
        "reference_end": "opposite_esp32",
        "position_direction": "toward_esp32",
        "installation_order": "top_to_bottom",
        "spacing_cm": 20,
        "height_reference": "probe_1",
        "sensors": mapping_entries(roms),
    }
    if configuration is not None:
        document["configuration_generation"] = configuration.generation
        document["configuration_crc32"] = configuration.crc32

    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _valid_temperatures(scan: ScanResult) -> dict[str, float]:
    if scan.overflow:
        raise ProtocolError(
            f"probe scan overflowed ({scan.bus_count} devices on the bus)"
        )
    missing = [probe.rom for probe in scan.probes if probe.temperature_c is None]
    if missing:
        raise ProtocolError(
            "probe(s) have no valid temperature: " + ", ".join(sorted(missing))
        )
    return {
        probe.rom: probe.temperature_c
        for probe in scan.probes
        if probe.temperature_c is not None
    }


def collect_connected(
    client: CommissioningClient, output: Path
) -> list[str]:
    print(
        "Disconnect all probes from the 1-Wire bus. You will then connect them "
        "one at a time, starting with probe 1 at the top/farthest end."
    )
    input("Press Enter when no probes are connected... ")
    previous = client.scan()
    if previous.probes:
        raise ProtocolError(
            f"expected an empty bus, but found {len(previous.probes)} probe(s); "
            "disconnect them or use --method warm"
        )

    mapped: list[str] = []
    previous_roms: set[str] = set()
    for position in range(1, EXPECTED_SENSORS + 1):
        location = (
            "top/farthest from the ESP32"
            if position == 1
            else "bottom/nearest the ESP32"
            if position == EXPECTED_SENSORS
            else "the next position toward the ESP32"
        )
        while True:
            input(f"\nConnect probe {position} ({location}), then press Enter... ")
            scan = client.scan()
            try:
                temperatures = _valid_temperatures(scan)
                rom = one_added_rom(previous_roms, temperatures)
            except ProtocolError as error:
                print(f"  Not accepted: {error}")
                print("  Correct the connection and try this position again.")
                continue
            mapped.append(rom)
            previous_roms = set(temperatures)
            save_mapping(output, mapped)
            print(
                f"Identified probe {position}: {rom} "
                f"({temperatures[rom]:.2f} C); saved {output}"
            )
            break
    return mapped


def learn_baselines(client: CommissioningClient) -> dict[str, float]:
    history: dict[str, list[float]] = {}
    expected_roms: set[str] | None = None
    print(f"Learning ambient baselines from {BASELINE_SAMPLES} complete scans...")
    complete = 0
    while complete < BASELINE_SAMPLES:
        scan = client.scan()
        try:
            temperatures = _valid_temperatures(scan)
            if len(temperatures) != EXPECTED_SENSORS:
                raise ProtocolError(
                    f"expected {EXPECTED_SENSORS} probes, found {len(temperatures)}"
                )
            if expected_roms is None:
                expected_roms = set(temperatures)
            elif set(temperatures) != expected_roms:
                raise ProtocolError("the discovered probe set changed")
        except ProtocolError as error:
            print(f"  Ignored scan: {error}")
            continue
        for rom, temperature in temperatures.items():
            history.setdefault(rom, []).append(temperature)
        complete += 1
        print(f"  baseline scan {complete}/{BASELINE_SAMPLES}")
    return {rom: statistics.median(values) for rom, values in history.items()}


def detect_warmed_sensor(
    client: CommissioningClient,
    baselines: dict[str, float],
    already_mapped: set[str],
) -> tuple[str, float, float]:
    while True:
        scan = client.scan()
        try:
            temperatures = _valid_temperatures(scan)
            if set(temperatures) != set(baselines):
                raise ProtocolError("the discovered probe set changed")
        except ProtocolError as error:
            print(f"\n  Ignored scan: {error}")
            continue

        strongest = strongest_warming(temperatures, baselines, already_mapped)
        if strongest is None:
            continue
        print(
            f"\r  strongest change: {strongest.rom} "
            f"{strongest.temperature_c:6.2f} C "
            f"(delta {strongest.rise_c:+5.2f} C)",
            end="",
            flush=True,
        )
        accepted = select_warmed_probe(temperatures, baselines, already_mapped)
        if accepted is not None:
            print()
            return accepted.rom, accepted.temperature_c, accepted.rise_c


def collect_warmed(client: CommissioningClient, output: Path) -> list[str]:
    print(
        "Connect all eight probes and let them reach a common ambient temperature. "
        "You will warm them one at a time, starting at the top/farthest end."
    )
    input("Press Enter when all probes are connected and stable... ")
    baselines = learn_baselines(client)
    print(f"Found {len(baselines)} stable probe baselines.")

    mapped: list[str] = []
    while len(mapped) < EXPECTED_SENSORS:
        position = len(mapped) + 1
        input(
            f"\nWarm probe {position} from the top/farthest end, "
            "then press Enter... "
        )
        rom, temperature, rise = detect_warmed_sensor(
            client, baselines, set(mapped)
        )
        mapped.append(rom)
        save_mapping(output, mapped)
        print(
            f"Identified probe {position}: {rom} "
            f"({temperature:.2f} C, rise {rise:.2f} C); saved {output}"
        )
        if len(mapped) < EXPECTED_SENSORS:
            input(
                "Remove the heat, move to the next probe, then press Enter to continue... "
            )
    return mapped


def read_active_configuration(
    port_path: str,
    baud: int,
) -> tuple[ProbeConfiguration, list[str]]:
    """Reconnect and return one boot-activated, bus-verified mapping."""

    deadline = time.monotonic() + REBOOT_VERIFY_TIMEOUT_SECONDS
    last_connection_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with serial.Serial(port_path, baud, timeout=0.25) as port:
                time.sleep(1)
                port.reset_input_buffer()
                client = CommissioningClient(port)
                info = client.info()
                require_compatible_device(info)

                configuration = client.get_configuration()
                read_back = tuple(probe.rom for probe in configuration.probes)
                if configuration.state != "valid":
                    raise ProtocolError(
                        "rebooted logger has no readable probe configuration"
                    )
                require_active_generation(info, configuration.generation)

                # A configured logger accepts a disruptive fresh scan only in
                # an explicit transaction, so normal 10-second acquisition can
                # never be starved by diagnostic polling.
                client.begin()
                try:
                    scan = client.scan()
                except Exception:
                    try:
                        client.abort()
                    except Exception:
                        pass
                    raise
                client.abort()
                if scan.overflow or {probe.rom for probe in scan.probes} != set(
                    read_back
                ):
                    raise ProtocolError(
                        "rebooted logger does not discover the complete mapped "
                        "probe set"
                    )
                return configuration, list(read_back)
        except (serial.SerialException, TimeoutError) as error:
            last_connection_error = error
            time.sleep(0.5)
            continue

    detail = f": {last_connection_error}" if last_connection_error else ""
    raise TimeoutError(f"logger did not become available for verification{detail}")


def verify_rebooted_configuration(
    port_path: str,
    baud: int,
    expected: ProbeConfiguration,
    expected_roms: list[str],
) -> None:
    """Prove that boot selected the exact configuration just committed."""

    actual, actual_roms = read_active_configuration(port_path, baud)
    if (
        actual.generation != expected.generation
        or actual.crc32 != expected.crc32
        or actual_roms != expected_roms
    ):
        raise ProtocolError(
            "rebooted configuration does not match the committed readback"
        )


def main() -> int:
    args = arguments()
    recovered_existing = False
    recover_without_readback = False
    pending_output = pending_mapping_path(args.output)
    try:
        with serial.Serial(args.port, args.baud, timeout=0.25) as port:
            time.sleep(1)
            port.reset_input_buffer()
            client = CommissioningClient(port)

            info = client.info()
            require_compatible_device(info)
            print(
                f"Connected to {info.product}, firmware {info.firmware} "
                f"({info.commit}), OTA slot {info.ota}."
            )

            current = client.get_configuration()
            if info.commissioning and not info.restart_required:
                print(
                    "Clearing an abandoned commissioning lock before continuing."
                )
                client.abort()
            if info.restart_required:
                recovered_existing = True
                if current.state == "valid":
                    mapped = [probe.rom for probe in current.probes]
                    configuration = current
                else:
                    recover_without_readback = True
                print(
                    "A previous commit has an unresolved activation result; "
                    "rebooting before any new commissioning."
                )
                client.reboot()
            elif current.state == "valid" and pending_mapping_matches(
                pending_output, [probe.rom for probe in current.probes]
            ):
                mapped = [probe.rom for probe in current.probes]
                configuration = current
                recovered_existing = True
                print(
                    "The active mapping matches a complete pending file; "
                    "verifying and promoting that recovered result."
                )
            elif current.state == "valid":
                answer = input(
                    "The logger already has a valid probe mapping. "
                    "Type REPLACE to commission it again: "
                )
                if answer != "REPLACE":
                    print("Existing mapping left unchanged.")
                    return 1
            if not recovered_existing:
                try:
                    client.begin()
                    with CommissioningLease(
                        client,
                        on_error=lambda error: print(
                            f"\nCommissioning keepalive failed: {error}",
                            file=sys.stderr,
                            flush=True,
                        ),
                    ) as lease:
                        mapped = (
                            collect_connected(client, pending_output)
                            if args.method == "connect"
                            else collect_warmed(client, pending_output)
                        )

                        final_scan = client.scan()
                        temperatures = _valid_temperatures(final_scan)
                        if set(temperatures) != set(mapped):
                            raise ProtocolError(
                                "final discovered probe set does not exactly match "
                                "the mapping"
                            )
                        lease.check()
                    configuration = client.finish_configuration(mapped)
                    client.reboot()
                except (Exception, KeyboardInterrupt):
                    try:
                        client.abort()
                    except Exception:
                        pass
                    raise
        if recover_without_readback:
            configuration, mapped = read_active_configuration(
                args.port, args.baud
            )
        else:
            verify_rebooted_configuration(
                args.port, args.baud, configuration, mapped
            )
        save_mapping(args.output, mapped, configuration)
        if not recovered_existing or pending_mapping_matches(pending_output, mapped):
            pending_output.unlink(missing_ok=True)
        elif pending_output.exists():
            print(
                f"Kept non-matching partial work in {pending_output} for review.",
                file=sys.stderr,
            )
        print(
            f"Commissioning complete: active generation {configuration.generation}, "
            f"CRC32 {configuration.crc32}. Verified mapping saved to {args.output}."
        )
        return 0

    except serial.SerialException as error:
        print(f"Serial error: {error}", file=sys.stderr)
        return 1
    except (DeviceError, ProtocolError, TimeoutError) as error:
        print(f"Commissioning failed: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped; use CFG GET or run the tool again to verify the device mapping.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
