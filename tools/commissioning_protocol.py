#!/usr/bin/env python3
"""Pure helpers and a serial client for the sauna commissioning protocol.

The wire format deliberately stays small: one ASCII message per line, a
machine-readable message name, and whitespace-separated ``key=value`` fields.
Keeping framing and validation here lets the interactive Python tool and the
future Web Serial client follow the same transactions.
"""

from __future__ import annotations

import math
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Protocol, Sequence


PROTOCOL_VERSION = 1
EXPECTED_PRODUCT = "sauna_logger"
EXPECTED_PARTITION = "sauna_ota_v1"
EXPECTED_OTA_SLOTS = frozenset({"app0", "app1"})
EXPECTED_SENSORS = 8
GEOMETRY_ID = "column8_20cm_v1"
MINIMUM_RISE_C = 3.0
WINNER_MARGIN_C = 1.0
MAXIMUM_LINE_LENGTH = 512

MESSAGE_NAME = re.compile(r"[A-Z][A-Z0-9_]*\Z")
FIELD_NAME = re.compile(r"[a-z][a-z0-9_]*\Z")
ROM_TEXT = re.compile(r"[0-9A-Fa-f]{16}\Z")
CRC32_TEXT = re.compile(r"[0-9A-Fa-f]{8}\Z")


class ProtocolError(ValueError):
    """The device response or proposed configuration is not trustworthy."""


class DeviceError(RuntimeError):
    """The logger explicitly refused a commissioning command."""

    def __init__(self, message: "Message"):
        self.message = message
        command = message.fields.get("command", "unknown")
        code = message.fields.get("code", "unknown")
        super().__init__(f"device refused {command}: {code}")


@dataclass(frozen=True)
class Message:
    name: str
    fields: Mapping[str, str]


@dataclass(frozen=True)
class DeviceInfo:
    protocol: int
    product: str
    firmware: str
    commit: str
    partition: str
    ota: str
    configured: bool
    active_generation: int
    restart_required: bool
    commissioning: bool


@dataclass(frozen=True)
class ProbeReading:
    rom: str
    temperature_c: float | None


@dataclass(frozen=True)
class ScanResult:
    probes: tuple[ProbeReading, ...]
    bus_count: int
    overflow: bool

    @property
    def temperatures(self) -> dict[str, float | None]:
        return {probe.rom: probe.temperature_c for probe in self.probes}


@dataclass(frozen=True)
class MappedProbe:
    position: int
    rom: str


@dataclass(frozen=True)
class ProbeConfiguration:
    state: str
    generation: int
    geometry: str
    probes: tuple[MappedProbe, ...]
    crc32: str


@dataclass(frozen=True)
class WarmCandidate:
    rom: str
    temperature_c: float
    rise_c: float
    margin_c: float


class SerialPort(Protocol):
    """The small pyserial surface used by :class:`CommissioningClient`."""

    def write(self, data: bytes) -> object:
        ...

    def readline(self) -> bytes:
        ...


def parse_line(line: str) -> Message:
    """Parse one strict ASCII protocol line while allowing additive fields."""

    text = line.strip("\r\n")
    if not text:
        raise ProtocolError("empty protocol line")
    if len(text) > MAXIMUM_LINE_LENGTH:
        raise ProtocolError("protocol line is too long")
    try:
        text.encode("ascii")
    except UnicodeEncodeError as error:
        raise ProtocolError("protocol line is not ASCII") from error

    tokens = text.split()
    name = tokens[0]
    if not MESSAGE_NAME.fullmatch(name):
        raise ProtocolError(f"invalid message name: {name!r}")

    fields: dict[str, str] = {}
    for token in tokens[1:]:
        key, separator, value = token.partition("=")
        if not separator or not value or not FIELD_NAME.fullmatch(key):
            raise ProtocolError(f"invalid protocol field: {token!r}")
        if key in fields:
            raise ProtocolError(f"duplicate protocol field: {key}")
        fields[key] = value
    return Message(name, fields)


def maxim_crc8(data: bytes) -> int:
    """Return the Dallas/Maxim 1-Wire CRC-8 for *data*."""

    crc = 0
    for byte in data:
        value = byte
        for _ in range(8):
            mix = (crc ^ value) & 1
            crc >>= 1
            if mix:
                crc ^= 0x8C
            value >>= 1
    return crc


def normalize_rom(value: str) -> str:
    """Validate and canonicalize one DS18B20 ROM address."""

    if not ROM_TEXT.fullmatch(value):
        raise ProtocolError(f"invalid 1-Wire ROM syntax: {value!r}")
    raw = bytes.fromhex(value)
    if raw[0] != 0x28:
        raise ProtocolError(f"unsupported 1-Wire family: {raw[0]:02X}")
    if maxim_crc8(raw[:-1]) != raw[-1]:
        raise ProtocolError(f"invalid 1-Wire ROM CRC: {value.upper()}")
    return value.upper()


def validate_mapping(roms: Sequence[str]) -> tuple[str, ...]:
    if len(roms) != EXPECTED_SENSORS:
        raise ProtocolError(
            f"expected {EXPECTED_SENSORS} mapped probes, found {len(roms)}"
        )
    normalized = tuple(normalize_rom(rom) for rom in roms)
    if len(set(normalized)) != EXPECTED_SENSORS:
        raise ProtocolError("probe mapping contains duplicate ROM addresses")
    return normalized


def _required(message: Message, field: str) -> str:
    try:
        return message.fields[field]
    except KeyError as error:
        raise ProtocolError(f"{message.name} is missing {field}") from error


def _unsigned(message: Message, field: str) -> int:
    value = _required(message, field)
    if not value.isdecimal():
        raise ProtocolError(f"{message.name} has invalid {field}: {value!r}")
    return int(value)


def _boolean(message: Message, field: str) -> bool:
    value = _unsigned(message, field)
    if value not in {0, 1}:
        raise ProtocolError(f"{message.name} has invalid {field}: {value!r}")
    return bool(value)


def _messages(lines: Iterable[str | Message]) -> list[Message]:
    result: list[Message] = []
    for line in lines:
        message = line if isinstance(line, Message) else parse_line(line)
        if message.name == "TELEM":
            continue
        if message.name == "CFG_ERROR":
            raise DeviceError(message)
        result.append(message)
    return result


def parse_device_info(line: str | Message) -> DeviceInfo:
    message = line if isinstance(line, Message) else parse_line(line)
    if message.name != "SYS_INFO":
        raise ProtocolError(f"expected SYS_INFO, found {message.name}")
    protocol = _unsigned(message, "protocol")
    return DeviceInfo(
        protocol=protocol,
        product=_required(message, "product"),
        firmware=_required(message, "firmware"),
        commit=_required(message, "commit"),
        partition=_required(message, "partition"),
        ota=_required(message, "ota"),
        configured=_boolean(message, "configured"),
        active_generation=_unsigned(message, "active_generation"),
        restart_required=_boolean(message, "restart_required"),
        commissioning=_boolean(message, "commissioning"),
    )


def require_compatible_device(info: DeviceInfo) -> None:
    """Refuse to commission a serial device outside this protocol contract."""

    if info.protocol != PROTOCOL_VERSION:
        raise ProtocolError(
            f"device protocol {info.protocol} is not supported; "
            f"this tool supports {PROTOCOL_VERSION}"
        )
    if info.product != EXPECTED_PRODUCT:
        raise ProtocolError(
            f"unexpected device product {info.product!r}; "
            f"expected {EXPECTED_PRODUCT!r}"
        )
    if info.partition != EXPECTED_PARTITION:
        raise ProtocolError(
            f"unexpected partition layout {info.partition!r}; "
            f"expected {EXPECTED_PARTITION!r}"
        )
    if info.ota not in EXPECTED_OTA_SLOTS:
        expected = ", ".join(sorted(EXPECTED_OTA_SLOTS))
        raise ProtocolError(
            f"unexpected running OTA slot {info.ota!r}; expected {expected}"
        )


def require_active_generation(info: DeviceInfo, expected_generation: int) -> None:
    """Confirm that a reboot activated the exact committed generation."""

    if not info.configured:
        raise ProtocolError("logger rebooted without an active probe configuration")
    if info.restart_required:
        raise ProtocolError("logger still reports that a restart is required")
    if info.commissioning:
        raise ProtocolError("logger still has autonomous logging suspended")
    if info.active_generation != expected_generation:
        raise ProtocolError(
            "logger activated configuration generation "
            f"{info.active_generation}, expected {expected_generation}"
        )


def _temperature(message: Message) -> float | None:
    value = _required(message, "temperature_c")
    if value == "NA":
        return None
    try:
        temperature = float(value)
    except ValueError as error:
        raise ProtocolError(f"invalid temperature: {value!r}") from error
    if not math.isfinite(temperature) or not -55.0 <= temperature <= 125.0:
        raise ProtocolError(f"temperature is outside DS18B20 range: {value!r}")
    return temperature


def parse_scan(lines: Iterable[str | Message]) -> ScanResult:
    messages = _messages(lines)
    if len(messages) < 2 or messages[0].name != "CFG_SCAN_BEGIN":
        raise ProtocolError("scan response is missing CFG_SCAN_BEGIN")
    if messages[-1].name != "CFG_SCAN_END":
        raise ProtocolError("scan response is missing CFG_SCAN_END")

    begin_count = _unsigned(messages[0], "count")
    bus_count = _unsigned(messages[0], "bus_count")
    overflow = _boolean(messages[0], "overflow")
    end_count = _unsigned(messages[-1], "count")
    probes: list[ProbeReading] = []
    for message in messages[1:-1]:
        if message.name != "CFG_SCAN_SENSOR":
            raise ProtocolError(f"unexpected message in scan: {message.name}")
        probes.append(
            ProbeReading(normalize_rom(_required(message, "rom")), _temperature(message))
        )

    if begin_count != end_count or begin_count != len(probes):
        raise ProtocolError(
            "scan count does not match its begin/end framing "
            f"({begin_count}/{len(probes)}/{end_count})"
        )
    if begin_count > bus_count:
        raise ProtocolError(
            f"scan reports {begin_count} usable probes on a {bus_count}-probe bus"
        )
    if len({probe.rom for probe in probes}) != len(probes):
        raise ProtocolError("scan contains a duplicate ROM address")
    return ScanResult(tuple(probes), bus_count, overflow)


def parse_configuration(lines: Iterable[str | Message]) -> ProbeConfiguration:
    messages = _messages(lines)
    if len(messages) < 2 or messages[0].name != "CFG_GET_BEGIN":
        raise ProtocolError("configuration response is missing CFG_GET_BEGIN")
    if messages[-1].name != "CFG_GET_END":
        raise ProtocolError("configuration response is missing CFG_GET_END")

    begin = messages[0]
    end = messages[-1]
    state = _required(begin, "state")
    if state not in {"unconfigured", "valid", "invalid"}:
        raise ProtocolError(f"unknown configuration state: {state!r}")
    generation = _unsigned(begin, "generation")
    geometry = _required(begin, "geometry")
    expected_count = _unsigned(begin, "count")
    end_count = _unsigned(end, "count")
    crc32 = _required(end, "crc32").upper()
    if not CRC32_TEXT.fullmatch(crc32):
        raise ProtocolError(f"invalid configuration CRC32: {crc32!r}")

    probes: list[MappedProbe] = []
    for message in messages[1:-1]:
        if message.name != "CFG_MAP":
            raise ProtocolError(f"unexpected message in configuration: {message.name}")
        probes.append(
            MappedProbe(
                _unsigned(message, "position"),
                normalize_rom(_required(message, "rom")),
            )
        )

    if expected_count != end_count or expected_count != len(probes):
        raise ProtocolError(
            "configuration count does not match its begin/end framing "
            f"({expected_count}/{len(probes)}/{end_count})"
        )
    positions = [probe.position for probe in probes]
    if positions != list(range(1, len(probes) + 1)):
        raise ProtocolError("configuration positions are missing, duplicated, or unordered")
    if len({probe.rom for probe in probes}) != len(probes):
        raise ProtocolError("configuration contains a duplicate ROM address")
    if state == "valid":
        if geometry != GEOMETRY_ID:
            raise ProtocolError(f"unsupported configuration geometry: {geometry!r}")
        validate_mapping([probe.rom for probe in probes])
    elif probes:
        raise ProtocolError(f"{state} configuration unexpectedly contains a mapping")

    return ProbeConfiguration(
        state=state,
        generation=generation,
        geometry=geometry,
        probes=tuple(probes),
        crc32=crc32,
    )


def one_added_rom(previous: Iterable[str], current: Iterable[str]) -> str:
    """Return the sole newly connected probe, refusing every ambiguous change."""

    before = {normalize_rom(rom) for rom in previous}
    after = {normalize_rom(rom) for rom in current}
    missing = before - after
    added = after - before
    if missing:
        raise ProtocolError(
            "previously connected probe(s) disappeared: " + ", ".join(sorted(missing))
        )
    if len(added) != 1:
        raise ProtocolError(f"expected exactly one new probe, found {len(added)}")
    return next(iter(added))


def strongest_warming(
    temperatures: Mapping[str, float | None],
    baselines: Mapping[str, float],
    already_mapped: Iterable[str],
) -> WarmCandidate | None:
    mapped = {normalize_rom(rom) for rom in already_mapped}
    rises: list[tuple[float, str, float]] = []
    for value, temperature in temperatures.items():
        rom = normalize_rom(value)
        if temperature is None or rom in mapped or rom not in baselines:
            continue
        rises.append((temperature - baselines[rom], rom, temperature))
    if not rises:
        return None
    rises.sort(reverse=True)
    rise, rom, temperature = rises[0]
    second_rise = rises[1][0] if len(rises) > 1 else 0.0
    return WarmCandidate(rom, temperature, rise, rise - second_rise)


def select_warmed_probe(
    temperatures: Mapping[str, float | None],
    baselines: Mapping[str, float],
    already_mapped: Iterable[str],
) -> WarmCandidate | None:
    candidate = strongest_warming(temperatures, baselines, already_mapped)
    if (
        candidate is not None
        and candidate.rise_c >= MINIMUM_RISE_C
        and candidate.margin_c >= WINNER_MARGIN_C
    ):
        return candidate
    return None


class CommissioningClient:
    """Sequential client for the framed SYS/CFG protocol."""

    def __init__(self, port: SerialPort, timeout: float = 8.0):
        self.port = port
        self.timeout = timeout
        self._io_lock = threading.Lock()

    def _write(self, command: str) -> None:
        self.port.write((command + "\n").encode("ascii"))

    def _response(
        self,
        command: str,
        begin_name: str,
        end_name: str,
        member_name: str | None = None,
        timeout: float | None = None,
    ) -> list[Message]:
        with self._io_lock:
            return self._response_locked(
                command, begin_name, end_name, member_name, timeout
            )

    def _response_locked(
        self,
        command: str,
        begin_name: str,
        end_name: str,
        member_name: str | None = None,
        timeout: float | None = None,
    ) -> list[Message]:
        self._write(command)
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        started = False
        response: list[Message] = []
        while time.monotonic() < deadline:
            raw = self.port.readline()
            if not raw:
                continue
            try:
                line = raw.decode("ascii").strip()
            except UnicodeDecodeError:
                if started:
                    raise ProtocolError("non-ASCII data inside protocol response")
                continue
            if not line:
                continue
            try:
                message = parse_line(line)
            except ProtocolError:
                if started and line.startswith(("CFG_", "SYS_")):
                    raise
                continue
            if message.name == "TELEM":
                continue
            if message.name in {"CFG_ERROR", "SYS_ERROR"}:
                raise DeviceError(message)
            if not started:
                if message.name != begin_name:
                    continue
                started = True
                response.append(message)
                if begin_name == end_name:
                    return response
                continue
            if message.name == end_name:
                response.append(message)
                return response
            if member_name is not None and message.name == member_name:
                response.append(message)
                continue
            if message.name.startswith(("CFG_", "SYS_")):
                raise ProtocolError(f"unexpected response message: {message.name}")
            # Runtime logger events may be interleaved with a response.
        raise TimeoutError(f"timed out waiting for response to {command!r}")

    def _ack(self, command: str, name: str) -> Message:
        message = self._response(command, name, name)[0]
        if message.fields.get("ok") != "1":
            raise ProtocolError(f"{name} did not confirm success")
        return message

    def info(self) -> DeviceInfo:
        return parse_device_info(self._response("SYS INFO", "SYS_INFO", "SYS_INFO")[0])

    def scan(self) -> ScanResult:
        return parse_scan(
            self._response(
                "CFG SCAN",
                "CFG_SCAN_BEGIN",
                "CFG_SCAN_END",
                "CFG_SCAN_SENSOR",
            )
        )

    def get_configuration(self) -> ProbeConfiguration:
        return parse_configuration(
            self._response(
                "CFG GET", "CFG_GET_BEGIN", "CFG_GET_END", "CFG_MAP"
            )
        )

    def begin(self, geometry: str = GEOMETRY_ID) -> None:
        try:
            self._ack(f"CFG BEGIN geometry={geometry}", "CFG_BEGIN")
        except Exception:
            # BEGIN may have reached the logger even when its acknowledgement
            # was lost. ABORT is idempotent and prevents a silent 10-minute
            # commissioning lock after a failed client transaction.
            try:
                self.abort()
            except Exception:
                pass
            raise

    def set_probe(self, position: int, rom: str) -> None:
        canonical = normalize_rom(rom)
        message = self._ack(
            f"CFG SET position={position} rom={canonical}", "CFG_SET"
        )
        if _unsigned(message, "position") != position:
            raise ProtocolError("CFG_SET acknowledged the wrong position")
        if normalize_rom(_required(message, "rom")) != canonical:
            raise ProtocolError("CFG_SET acknowledged the wrong ROM address")

    def commit(self) -> Message:
        return self._ack("CFG COMMIT", "CFG_COMMIT")

    def abort(self) -> None:
        self._ack("CFG ABORT", "CFG_ABORT")

    def keepalive(self) -> None:
        self._ack("CFG KEEPALIVE", "CFG_KEEPALIVE")

    def reboot(self) -> None:
        # Firmware flushes this acknowledgement before restarting. A serial
        # disconnect after the complete line is therefore expected and safe.
        self._ack("SYS REBOOT", "SYS_REBOOT")

    def finish_configuration(self, roms: Sequence[str]) -> ProbeConfiguration:
        """Populate an already-started transaction and verify stored readback."""

        try:
            canonical = validate_mapping(roms)
            for position, rom in enumerate(canonical, 1):
                self.set_probe(position, rom)
            self.commit()
        except Exception:
            try:
                self.abort()
            except Exception:
                pass
            raise

        configuration = self.get_configuration()
        read_back = tuple(probe.rom for probe in configuration.probes)
        if configuration.state != "valid" or read_back != canonical:
            raise ProtocolError("committed mapping did not match CFG GET readback")
        return configuration

class CommissioningLease:
    """Keep an interactive configuration transaction alive across prompts."""

    def __init__(
        self,
        client: CommissioningClient,
        interval: float = 60.0,
        on_error: Callable[[Exception], None] | None = None,
    ):
        self.client = client
        self.interval = interval
        self.on_error = on_error
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._error: Exception | None = None

    def __enter__(self) -> "CommissioningLease":
        self._thread = threading.Thread(
            target=self._run,
            name="sauna-commissioning-keepalive",
            daemon=True,
        )
        self._thread.start()
        return self

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.client.keepalive()
            except Exception as error:
                self._error = error
                if self.on_error is not None:
                    self.on_error(error)
                return

    def check(self) -> None:
        if self._error is not None:
            raise ProtocolError(
                f"commissioning keepalive failed: {self._error}"
            ) from self._error

    def __exit__(self, exception_type, exception, traceback) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        if exception_type is None:
            self.check()
        return False
