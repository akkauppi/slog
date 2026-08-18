import json
import sys
import tempfile
import threading
import unittest
from collections import deque
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import commissioning_protocol as protocol
import identify_sensors


ROMS = (
    "2825E1BD00000058",
    "2856BE530000003F",
    "287C38C000000078",
    "28D92E50000000CE",
    "289ABC52000000D1",
    "28CD19520000009B",
    "28939352000000D0",
    "2801F3520000001E",
)


def scan_lines(roms=ROMS, missing_temperature=()) -> list[str]:
    lines = [
        f"CFG_SCAN_BEGIN count={len(roms)} bus_count={len(roms)} overflow=0"
    ]
    for index, rom in enumerate(roms):
        temperature = "NA" if rom in missing_temperature else f"{20 + index / 4:.2f}"
        lines.append(f"CFG_SCAN_SENSOR rom={rom.lower()} temperature_c={temperature}")
    lines.append(f"CFG_SCAN_END count={len(roms)}")
    return lines


def configuration_lines(roms=ROMS, state="valid") -> list[str]:
    geometry = protocol.GEOMETRY_ID if state == "valid" else "none"
    lines = [
        f"CFG_GET_BEGIN state={state} generation=7 geometry={geometry} "
        f"count={len(roms)}"
    ]
    lines.extend(
        f"CFG_MAP position={position} rom={rom}"
        for position, rom in enumerate(roms, 1)
    )
    lines.append(f"CFG_GET_END count={len(roms)} crc32=89abcdef")
    return lines


def info_line(**overrides) -> str:
    fields = {
        "protocol": "1",
        "product": "sauna_logger",
        "firmware": "dev",
        "commit": "dirty",
        "partition": "sauna_ota_v1",
        "ota": "app0",
        "configured": "1",
        "active_generation": "7",
        "restart_required": "0",
        "commissioning": "0",
    }
    fields.update({key: str(value) for key, value in overrides.items()})
    return "SYS_INFO " + " ".join(f"{key}={value}" for key, value in fields.items())


class FakeSerial:
    def __init__(self, exchanges):
        self.exchanges = deque(exchanges)
        self.reads = deque()
        self.commands = []

    def write(self, data):
        command = data.decode("ascii").rstrip("\n")
        self.commands.append(command)
        if not self.exchanges:
            raise AssertionError(f"unexpected command: {command}")
        expected, response = self.exchanges.popleft()
        if command != expected:
            raise AssertionError(f"expected {expected!r}, found {command!r}")
        self.reads.extend((line + "\r\n").encode("ascii") for line in response)
        return len(data)

    def readline(self):
        return self.reads.popleft() if self.reads else b""

    def reset_input_buffer(self):
        self.reads.clear()

    def __enter__(self):
        return self

    def __exit__(self, exception_type, exception, traceback):
        return False


class DisconnectingSerial(FakeSerial):
    def reset_input_buffer(self):
        raise identify_sensors.serial.SerialException("port re-enumerated")


class MessageTests(unittest.TestCase):
    def test_key_value_message_allows_additive_fields(self):
        message = protocol.parse_line(
            "SYS_INFO protocol=1 product=saunan extra=future\r\n"
        )
        self.assertEqual(message.name, "SYS_INFO")
        self.assertEqual(message.fields["extra"], "future")

    def test_malformed_and_duplicate_fields_are_rejected(self):
        for line in (
            "SYS_INFO protocol",
            "SYS_INFO Protocol=1",
            "SYS_INFO protocol=1 protocol=2",
            "not_upper protocol=1",
            "SYS_INFO protocol=",
        ):
            with self.subTest(line=line), self.assertRaises(protocol.ProtocolError):
                protocol.parse_line(line)

    def test_device_info_requires_compatibility_fields(self):
        info = protocol.parse_device_info(
            "SYS_INFO protocol=1 product=sauna_logger firmware=2.1.0 "
            "commit=abc123 partition=sauna_ota_v1 ota=app0 configured=1 "
            "active_generation=7 restart_required=0 commissioning=0"
        )
        self.assertEqual(info.protocol, 1)
        self.assertEqual(info.partition, "sauna_ota_v1")
        protocol.require_compatible_device(info)

    def test_device_compatibility_rejects_each_wrong_identity_field(self):
        compatible = {
            "protocol": 1,
            "product": "sauna_logger",
            "firmware": "dev",
            "commit": "dirty",
            "partition": "sauna_ota_v1",
            "ota": "app1",
            "configured": True,
            "active_generation": 7,
            "restart_required": False,
            "commissioning": False,
        }
        cases = {
            "protocol": 2,
            "product": "another_logger",
            "partition": "factory_layout",
            "ota": "factory",
        }
        for field, value in cases.items():
            fields = {**compatible, field: value}
            info = protocol.DeviceInfo(**fields)
            with self.subTest(field=field), self.assertRaises(protocol.ProtocolError):
                protocol.require_compatible_device(info)

    def test_active_generation_requires_a_completed_matching_reboot(self):
        good = protocol.parse_device_info(info_line())
        protocol.require_active_generation(good, 7)
        for overrides in (
            {"configured": "0"},
            {"restart_required": "1"},
            {"commissioning": "1"},
            {"active_generation": "6"},
        ):
            info = protocol.parse_device_info(info_line(**overrides))
            with self.subTest(overrides=overrides), self.assertRaises(
                protocol.ProtocolError
            ):
                protocol.require_active_generation(info, 7)


class RomAndSelectionTests(unittest.TestCase):
    def test_all_reference_roms_have_valid_family_and_crc(self):
        self.assertEqual(tuple(protocol.normalize_rom(rom.lower()) for rom in ROMS), ROMS)

    def test_invalid_family_and_crc_are_rejected(self):
        with self.assertRaisesRegex(protocol.ProtocolError, "family"):
            protocol.normalize_rom("1025E1BD00000058")
        with self.assertRaisesRegex(protocol.ProtocolError, "CRC"):
            protocol.normalize_rom("2825E1BD00000059")

    def test_exactly_one_added_probe_is_required(self):
        self.assertEqual(protocol.one_added_rom(ROMS[:2], ROMS[:3]), ROMS[2])
        with self.assertRaisesRegex(protocol.ProtocolError, "found 0"):
            protocol.one_added_rom(ROMS[:2], ROMS[:2])
        with self.assertRaisesRegex(protocol.ProtocolError, "found 2"):
            protocol.one_added_rom(ROMS[:2], ROMS[:4])
        with self.assertRaisesRegex(protocol.ProtocolError, "disappeared"):
            protocol.one_added_rom(ROMS[:2], (ROMS[1], ROMS[2]))

    def test_warm_selection_requires_rise_and_clear_margin(self):
        baselines = {rom: 20.0 for rom in ROMS}
        temperatures = {rom: 20.0 for rom in ROMS}
        temperatures[ROMS[0]] = 23.5
        temperatures[ROMS[1]] = 22.0
        candidate = protocol.select_warmed_probe(temperatures, baselines, set())
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.rom, ROMS[0])

        temperatures[ROMS[1]] = 22.8
        self.assertIsNone(
            protocol.select_warmed_probe(temperatures, baselines, set())
        )

    def test_warm_selection_excludes_already_mapped_probe(self):
        baselines = {rom: 20.0 for rom in ROMS}
        temperatures = {rom: 20.0 for rom in ROMS}
        temperatures[ROMS[0]] = 30.0
        temperatures[ROMS[1]] = 24.0
        candidate = protocol.select_warmed_probe(
            temperatures, baselines, {ROMS[0]}
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.rom, ROMS[1])


class FramingTests(unittest.TestCase):
    def test_scan_accepts_na_and_ignores_interleaved_telemetry(self):
        lines = scan_lines(missing_temperature={ROMS[3]})
        lines.insert(3, "TELEM sample=17 p1=22.00")
        scan = protocol.parse_scan(lines)
        self.assertEqual(len(scan.probes), 8)
        self.assertIsNone(scan.temperatures[ROMS[3]])
        self.assertEqual(scan.probes[0].rom, ROMS[0])

    def test_scan_rejects_bad_count_duplicate_and_missing_end(self):
        bad_count = scan_lines()
        bad_count[-1] = "CFG_SCAN_END count=7"
        duplicate = scan_lines((ROMS[0], ROMS[0]))
        for lines in (bad_count, duplicate, scan_lines()[:-1]):
            with self.subTest(lines=lines), self.assertRaises(protocol.ProtocolError):
                protocol.parse_scan(lines)

    def test_scan_validates_bus_count_and_overflow_fields(self):
        impossible = scan_lines(ROMS[:2])
        impossible[0] = impossible[0].replace("bus_count=2", "bus_count=1")
        with self.assertRaisesRegex(protocol.ProtocolError, "usable probes"):
            protocol.parse_scan(impossible)
        overflow = scan_lines()
        overflow[0] = overflow[0].replace("overflow=0", "overflow=1")
        parsed = protocol.parse_scan(overflow)
        self.assertTrue(parsed.overflow)

    def test_configuration_rejects_mismatched_end_count(self):
        lines = configuration_lines()
        lines[-1] = lines[-1].replace("count=8", "count=7")
        with self.assertRaises(protocol.ProtocolError):
            protocol.parse_configuration(lines)

    def test_configuration_preserves_p1_to_p8_order(self):
        configuration = protocol.parse_configuration(configuration_lines())
        self.assertEqual(configuration.state, "valid")
        self.assertEqual(configuration.generation, 7)
        self.assertEqual(
            tuple(probe.rom for probe in configuration.probes), ROMS
        )

    def test_configuration_rejects_missing_duplicate_or_unordered_positions(self):
        missing = configuration_lines(ROMS[:-1])
        missing[0] = missing[0].replace("count=7", "count=8")
        duplicate = configuration_lines(ROMS[:-1] + (ROMS[0],))
        unordered = configuration_lines()
        unordered[2] = unordered[2].replace("position=2", "position=3")
        for lines in (missing, duplicate, unordered):
            with self.subTest(lines=lines), self.assertRaises(protocol.ProtocolError):
                protocol.parse_configuration(lines)


class ClientTests(unittest.TestCase):
    def test_info_and_scan_ignore_boot_chatter_and_telemetry(self):
        serial_port = FakeSerial(
            [
                (
                    "SYS INFO",
                    [
                        "sauna logger starting",
                        info_line(),
                    ],
                ),
                (
                    "CFG SCAN",
                    [
                        "TELEM sample=4 p1=20.00",
                        scan_lines(ROMS[:1])[0],
                        "logger_event=storage_low",
                        *scan_lines(ROMS[:1])[1:],
                    ],
                ),
            ]
        )
        client = protocol.CommissioningClient(serial_port, timeout=0.1)
        self.assertEqual(client.info().product, "sauna_logger")
        self.assertEqual(client.scan().probes[0].rom, ROMS[0])

    def test_keepalive_has_an_explicit_acknowledgement(self):
        serial_port = FakeSerial(
            [("CFG KEEPALIVE", ["CFG_KEEPALIVE ok=1"])]
        )
        protocol.CommissioningClient(serial_port, timeout=0.1).keepalive()
        self.assertFalse(serial_port.exchanges)

    def test_transaction_stages_commits_reads_back_and_reboots(self):
        exchanges = [
            (
                f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                ["CFG_BEGIN ok=1"],
            )
        ]
        exchanges.extend(
            (
                f"CFG SET position={position} rom={rom}",
                [f"CFG_SET ok=1 position={position} rom={rom}"],
            )
            for position, rom in enumerate(ROMS, 1)
        )
        exchanges.extend(
            [
                ("CFG COMMIT", ["CFG_COMMIT ok=1 generation=7 crc32=89ABCDEF"]),
                ("CFG GET", configuration_lines()),
                ("SYS REBOOT", ["SYS_REBOOT ok=1"]),
            ]
        )
        serial_port = FakeSerial(exchanges)
        client = protocol.CommissioningClient(serial_port, timeout=0.1)
        client.begin()
        configuration = client.finish_configuration(ROMS)
        client.reboot()
        self.assertEqual(configuration.crc32, "89ABCDEF")
        self.assertEqual(serial_port.commands[-1], "SYS REBOOT")
        self.assertFalse(serial_port.exchanges)

    def test_finish_configuration_uses_an_existing_transaction(self):
        exchanges = [
            (
                f"CFG SET position={position} rom={rom}",
                [f"CFG_SET ok=1 position={position} rom={rom}"],
            )
            for position, rom in enumerate(ROMS, 1)
        ]
        exchanges.extend(
            [
                ("CFG COMMIT", ["CFG_COMMIT ok=1"]),
                ("CFG GET", configuration_lines()),
            ]
        )
        serial_port = FakeSerial(exchanges)
        protocol.CommissioningClient(
            serial_port, timeout=0.1
        ).finish_configuration(ROMS)
        self.assertNotIn(
            f"CFG BEGIN geometry={protocol.GEOMETRY_ID}", serial_port.commands
        )
        self.assertNotIn("SYS REBOOT", serial_port.commands)

    def test_set_error_causes_immediate_abort(self):
        serial_port = FakeSerial(
            [
                (
                    f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                    ["CFG_BEGIN ok=1"],
                ),
                (
                    f"CFG SET position=1 rom={ROMS[0]}",
                    ["CFG_ERROR command=set code=nvs_busy"],
                ),
                ("CFG ABORT", ["CFG_ABORT ok=1"]),
            ]
        )
        client = protocol.CommissioningClient(serial_port, timeout=0.1)
        client.begin()
        with self.assertRaisesRegex(protocol.DeviceError, "nvs_busy"):
            client.finish_configuration(ROMS)
        self.assertEqual(serial_port.commands[-1], "CFG ABORT")
        self.assertFalse(serial_port.exchanges)

    def test_post_commit_readback_mismatch_is_not_success(self):
        swapped = (ROMS[1], ROMS[0], *ROMS[2:])
        exchanges = [
            (
                f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                ["CFG_BEGIN ok=1"],
            )
        ]
        exchanges.extend(
            (
                f"CFG SET position={position} rom={rom}",
                [f"CFG_SET ok=1 position={position} rom={rom}"],
            )
            for position, rom in enumerate(ROMS, 1)
        )
        exchanges.extend(
            [
                ("CFG COMMIT", ["CFG_COMMIT ok=1"]),
                ("CFG GET", configuration_lines(swapped)),
            ]
        )
        client = protocol.CommissioningClient(FakeSerial(exchanges), timeout=0.1)
        client.begin()
        with self.assertRaisesRegex(protocol.ProtocolError, "readback"):
            client.finish_configuration(ROMS)

    def test_lost_begin_ack_is_followed_by_idempotent_abort(self):
        serial_port = FakeSerial(
            [
                (f"CFG BEGIN geometry={protocol.GEOMETRY_ID}", []),
                ("CFG ABORT", ["CFG_ABORT ok=1"]),
            ]
        )
        client = protocol.CommissioningClient(serial_port, timeout=0.01)
        with self.assertRaises(TimeoutError):
            client.begin()
        self.assertEqual(serial_port.commands[-1], "CFG ABORT")

    def test_keepalive_failure_is_reported_to_operator_and_caller(self):
        called = threading.Event()
        reported = []

        class FailingClient:
            def keepalive(self):
                called.set()
                raise RuntimeError("USB disconnected")

        with self.assertRaisesRegex(protocol.ProtocolError, "USB disconnected"):
            with protocol.CommissioningLease(
                FailingClient(), interval=0.001, on_error=reported.append
            ):
                self.assertTrue(called.wait(0.5))
        self.assertEqual(str(reported[0]), "USB disconnected")


class MappingFileTests(unittest.TestCase):
    def test_pending_mapping_is_distinct_and_keeps_verified_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sensor-map.json"
            path.write_text('{"verified": true}\n', encoding="utf-8")
            pending = identify_sensors.pending_mapping_path(path)
            identify_sensors.save_mapping(pending, list(ROMS[:2]))
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")), {"verified": True}
            )
            document = json.loads(pending.read_text(encoding="utf-8"))
            self.assertEqual(document["schema_version"], 1)
            self.assertEqual(document["reference_end"], "opposite_esp32")
            self.assertEqual(document["position_direction"], "toward_esp32")
            self.assertEqual(document["sensors"][0]["relative_height_cm"], 0)
            self.assertEqual(document["sensors"][1]["relative_height_cm"], -20)
            self.assertEqual(pending.name, "sensor-map.pending.json")
            self.assertFalse((path.parent / ".sensor-map.pending.json.tmp").exists())
            self.assertFalse(
                identify_sensors.pending_mapping_matches(pending, list(ROMS))
            )
            identify_sensors.save_mapping(pending, list(ROMS))
            self.assertTrue(
                identify_sensors.pending_mapping_matches(pending, list(ROMS))
            )

    def test_reboot_verification_checks_active_map_and_discovery(self):
        serial_port = FakeSerial(
            [
                ("SYS INFO", [info_line()]),
                ("CFG GET", configuration_lines()),
                (
                    f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                    ["CFG_BEGIN ok=1"],
                ),
                ("CFG SCAN", scan_lines()),
                ("CFG ABORT", ["CFG_ABORT ok=1"]),
            ]
        )
        expected = protocol.parse_configuration(configuration_lines())
        with mock.patch.object(
            identify_sensors.serial, "Serial", return_value=serial_port
        ), mock.patch.object(identify_sensors.time, "sleep"):
            identify_sensors.verify_rebooted_configuration(
                "/dev/fake", 115200, expected, list(ROMS)
            )
        self.assertFalse(serial_port.exchanges)

    def test_reboot_verification_rejects_wrong_active_generation(self):
        serial_port = FakeSerial(
            [
                ("SYS INFO", [info_line(active_generation="6")]),
                ("CFG GET", configuration_lines()),
            ]
        )
        expected = protocol.parse_configuration(configuration_lines())
        with mock.patch.object(
            identify_sensors.serial, "Serial", return_value=serial_port
        ), mock.patch.object(identify_sensors.time, "sleep"):
            with self.assertRaisesRegex(protocol.ProtocolError, "generation 6"):
                identify_sensors.verify_rebooted_configuration(
                    "/dev/fake", 115200, expected, list(ROMS)
                )

    def test_reboot_verification_retries_transient_serial_disconnect(self):
        stale_port = DisconnectingSerial([])
        ready_port = FakeSerial(
            [
                ("SYS INFO", [info_line()]),
                ("CFG GET", configuration_lines()),
                (
                    f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                    ["CFG_BEGIN ok=1"],
                ),
                ("CFG SCAN", scan_lines()),
                ("CFG ABORT", ["CFG_ABORT ok=1"]),
            ]
        )
        expected = protocol.parse_configuration(configuration_lines())
        with mock.patch.object(
            identify_sensors.serial,
            "Serial",
            side_effect=[stale_port, ready_port],
        ), mock.patch.object(identify_sensors.time, "sleep"):
            identify_sensors.verify_rebooted_configuration(
                "/dev/fake", 115200, expected, list(ROMS)
            )
        self.assertFalse(ready_port.exchanges)

    def test_main_reboots_and_recovers_an_unreadable_pending_commit(self):
        invalid_configuration = configuration_lines((), state="invalid")
        invalid_configuration[0] = invalid_configuration[0].replace(
            "generation=7", "generation=0"
        )
        pre_reboot = FakeSerial(
            [
                (
                    "SYS INFO",
                    [
                        info_line(
                            configured="0",
                            active_generation="0",
                            restart_required="1",
                        )
                    ],
                ),
                ("CFG GET", invalid_configuration),
                ("SYS REBOOT", ["SYS_REBOOT ok=1"]),
            ]
        )
        post_reboot = FakeSerial(
            [
                ("SYS INFO", [info_line()]),
                ("CFG GET", configuration_lines()),
                (
                    f"CFG BEGIN geometry={protocol.GEOMETRY_ID}",
                    ["CFG_BEGIN ok=1"],
                ),
                ("CFG SCAN", scan_lines()),
                ("CFG ABORT", ["CFG_ABORT ok=1"]),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "sensor-map.json"
            args = mock.Mock(
                port="/dev/fake", baud=115200, output=output, method="connect"
            )
            with mock.patch.object(
                identify_sensors, "arguments", return_value=args
            ), mock.patch.object(
                identify_sensors.serial,
                "Serial",
                side_effect=[pre_reboot, post_reboot],
            ), mock.patch.object(identify_sensors.time, "sleep"):
                self.assertEqual(identify_sensors.main(), 0)
            document = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(document["configuration_generation"], 7)
            self.assertEqual(
                [sensor["rom"] for sensor in document["sensors"]], list(ROMS)
            )

    def test_main_clears_an_abandoned_commissioning_lock(self):
        serial_port = FakeSerial(
            [
                ("SYS INFO", [info_line(commissioning="1")]),
                ("CFG GET", configuration_lines()),
                ("CFG ABORT", ["CFG_ABORT ok=1 restart_required=0"]),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            args = mock.Mock(
                port="/dev/fake",
                baud=115200,
                output=Path(directory) / "sensor-map.json",
                method="connect",
            )
            with mock.patch.object(
                identify_sensors, "arguments", return_value=args
            ), mock.patch.object(
                identify_sensors.serial, "Serial", return_value=serial_port
            ), mock.patch.object(
                identify_sensors.time, "sleep"
            ), mock.patch("builtins.input", return_value=""):
                self.assertEqual(identify_sensors.main(), 1)
        self.assertIn("CFG ABORT", serial_port.commands)


if __name__ == "__main__":
    unittest.main()
