#!/usr/bin/env python3
"""Prepare encrypted ESP-NOW pairing offline; apply only with an explicit port."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import struct
import time
import zlib


def mac_bytes(text):
    compact = text.replace(":", "").replace("-", "")
    if not re.fullmatch(r"[0-9a-fA-F]{12}", compact):
        raise ValueError("MAC must contain six hexadecimal bytes")
    raw = bytes.fromhex(compact)
    if not any(raw) or raw[0] & 1:
        raise ValueError("MAC must be a nonzero unicast address")
    return raw


def config_bytes(source, peer, channel, pmk, lmk):
    if not 1 <= channel <= 11 or len(pmk) != 16 or len(lmk) != 16 or not any(pmk) or not any(lmk):
        raise ValueError("invalid channel or keys")
    raw = b"SRAD" + bytes([1, 1, channel, 0]) + struct.pack("<Q", source) + peer + b"\0\0" + pmk + lmk
    return raw + struct.pack("<I", zlib.crc32(raw))


def prepare(logger, receiver, channel, output):
    logger, receiver = mac_bytes(logger), mac_bytes(receiver)
    if logger == receiver:
        raise ValueError("logger and receiver must be different devices")
    if not 1 <= channel <= 11:
        raise ValueError("channel must be 1..11")
    pmk, lmk = secrets.token_bytes(16), secrets.token_bytes(16)
    source = int.from_bytes(logger, "big")
    output.mkdir(mode=0o700)
    documents = {}
    for role, local, peer in [("logger", logger, receiver), ("receiver", receiver, logger)]:
        blob = config_bytes(source, peer, channel, pmk, lmk)
        document = {"schema": "saunan.pairing.v1", "role": role,
                    "target_mac": local.hex().upper(), "config_hex": blob.hex()}
        documents[role] = document
        fd = os.open(output / f"{role}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(document, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

    kit = {"schema": "saunan.pairing-kit.v1", **documents}
    fd = os.open(output / "pairing-kit.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(kit, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def load_pairing(path):
    document = json.loads(path.read_text())
    if document.get("schema") != "saunan.pairing.v1" or document.get("role") not in {"logger", "receiver"}:
        raise ValueError("unsupported pairing document")
    local = mac_bytes(document["target_mac"])
    raw = bytes.fromhex(document["config_hex"])
    if len(raw) != 60 or raw[:6] != b"SRAD\x01\x01" or not 1 <= raw[6] <= 11 or raw[7] or raw[22:24] != b"\0\0" or zlib.crc32(raw[:56]) != struct.unpack_from("<I", raw, 56)[0]:
        raise ValueError("invalid pairing config")
    peer = mac_bytes(raw[16:22].hex())
    source = int.from_bytes(raw[8:16], "little")
    if peer == local or not any(raw[24:40]) or not any(raw[40:56]):
        raise ValueError("invalid pairing peer or keys")
    if source != int.from_bytes(local if document["role"] == "logger" else peer, "big"):
        raise ValueError("pairing source does not match logger")
    return local.hex().upper(), raw


def request(device, command, prefix):
    # Never include command text in errors: configuration commands contain keys.
    device.write((command + "\n").encode("ascii"))
    deadline = time.monotonic() + 5
    line = bytearray()
    while time.monotonic() < deadline:
        byte = device.read(1)
        if byte == b"\n":
            text = line.decode("ascii", errors="replace").strip()
            line.clear()
            if text.startswith("RADIO_ERROR"):
                raise RuntimeError(text)
            if text.startswith(prefix + " "):
                return dict(part.split("=", 1) for part in text.split()[1:] if "=" in part)
        elif byte:
            line.extend(byte)
            if len(line) > 2048:
                raise RuntimeError("oversized serial response")
    raise RuntimeError("radio command timed out; outcome may be uncertain, inspect RADIO STATUS before retrying")


def apply(port, path):
    import serial  # prepare remains standard-library-only and never opens USB.
    expected_mac, raw = load_pairing(path)
    with serial.Serial(port, 115200, timeout=0.1, write_timeout=2) as device:
        device.write(b"\n")
        status = request(device, "RADIO STATUS", "RADIO_STATUS")
        if status.get("mac") != expected_mac:
            raise ValueError("connected unit is not the pairing document's target")
        if status.get("restart_required") != "0":
            raise ValueError("unit requires reboot before configuration")
        result = request(device, "RADIO " + raw.hex(), "RADIO_CONFIG")
        if result.get("ok") != "1" or result.get("restart_required") != "1":
            raise RuntimeError("configuration commit was not verified; reboot and inspect status")
    print("Pairing stored and read back. Reboot the unit to activate it; keys were not printed.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--logger-mac", required=True)
    prep.add_argument("--receiver-mac", required=True)
    prep.add_argument("--channel", type=int, default=6)
    prep.add_argument("--output", type=Path, required=True)
    install = sub.add_parser("apply")
    install.add_argument("--port", required=True)
    install.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "prepare":
            prepare(args.logger_mac, args.receiver_mac, args.channel, args.output)
            print("Created private logger.json, receiver.json and pairing-kit.json files. Keep both for offline recovery.")
        else:
            apply(args.port, args.config)
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        parser.exit(1, f"pairing error: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
