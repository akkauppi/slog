import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceError,
  ProtocolError,
  normalizeRom,
  oneAddedRom,
  parseConfiguration,
  parseDeviceInfo,
  parseLine,
  parseScan,
  requireActiveGeneration,
  requireCompatibleDevice,
  selectWarmedProbe,
  validateMapping,
} from "../../portal/js/protocol.js";
import { ROMS, configurationLines, infoLine, scanLines } from "./fixtures.js";

test("line parser is strict but permits additive fields", () => {
  const parsed = parseLine("SYS_INFO protocol=1 product=sauna_logger future=yes\r\n");
  assert.equal(parsed.fields.future, "yes");

  for (const line of [
    "SYS_INFO protocol",
    "SYS_INFO Protocol=1",
    "SYS_INFO protocol=1 protocol=2",
    "not_upper protocol=1",
    "SYS_INFO protocol=",
    `SYS_INFO value=${"x".repeat(513)}`,
    "SYS_INFO value=löyly",
  ]) {
    assert.throws(() => parseLine(line), ProtocolError, line);
  }
});

test("ROM and complete mapping validation enforce family, CRC, and uniqueness", () => {
  assert.equal(normalizeRom(ROMS[0].toLowerCase()), ROMS[0]);
  assert.deepEqual([...validateMapping([...ROMS])], ROMS);
  assert.throws(() => normalizeRom("1025E1BD00000058"), /family/);
  assert.throws(() => normalizeRom("2825E1BD00000059"), /CRC/);
  assert.throws(() => validateMapping([...ROMS.slice(0, 7), ROMS[0]]), /duplicate/);
});

test("device information has an explicit compatibility and activation contract", () => {
  const info = parseDeviceInfo(infoLine());
  assert.equal(info.activeGeneration, 7);
  assert.equal(info.restartRequired, false);
  assert.equal(requireCompatibleDevice(info), info);
  assert.equal(requireActiveGeneration(info, 7), info);

  for (const overrides of [
    { protocol: 2 },
    { product: "other" },
    { partition: "other" },
    { ota: "factory" },
  ]) {
    assert.throws(() => requireCompatibleDevice(parseDeviceInfo(infoLine(overrides))));
  }
  for (const overrides of [
    { configured: 0 },
    { restart_required: 1 },
    { commissioning: 1 },
    { active_generation: 6 },
  ]) {
    assert.throws(() => requireActiveGeneration(parseDeviceInfo(infoLine(overrides)), 7));
  }
});

test("scan parser validates framing, bus counts, temperatures, and mapped positions", () => {
  const lines = scanLines(ROMS.slice(0, 2), { missing: [ROMS[1]] });
  lines.splice(2, 0, "TELEM sample=9 p1=20.0");
  const scan = parseScan(lines);
  assert.equal(scan.probes[0].mappedPosition, 1);
  assert.equal(scan.probes[1].temperatureC, null);

  const badCount = scanLines(ROMS.slice(0, 2));
  badCount[0] = badCount[0].replace("count=2", "count=1");
  assert.throws(() => parseScan(badCount), /count/);

  const impossible = scanLines(ROMS.slice(0, 2));
  impossible[0] = impossible[0].replace("bus_count=2", "bus_count=1");
  assert.throws(() => parseScan(impossible), /usable probes/);

  const invalidTemperature = scanLines(ROMS.slice(0, 1));
  invalidTemperature[1] = invalidTemperature[1].replace("20.00", "126");
  assert.throws(() => parseScan(invalidTemperature), /temperature/);

  const nonDecimalTemperature = scanLines(ROMS.slice(0, 1));
  nonDecimalTemperature[1] = nonDecimalTemperature[1].replace("20.00", "0x10");
  assert.throws(() => parseScan(nonDecimalTemperature), /temperature/);

  const error = ["CFG_ERROR command=scan code=active_session"];
  assert.throws(() => parseScan(error), DeviceError);
});

test("configuration parser preserves P1-to-P8 order and geometry", () => {
  const configuration = parseConfiguration(configurationLines());
  assert.equal(configuration.state, "valid");
  assert.equal(configuration.probes[0].relativeHeightCm, 0);
  assert.equal(configuration.probes[7].relativeHeightCm, -140);
  assert.equal(configuration.crc32, "89ABCDEF");

  const wrongOrder = configurationLines();
  wrongOrder[2] = wrongOrder[2].replace("position=2", "position=3");
  assert.throws(() => parseConfiguration(wrongOrder), /positions/);

  const wrongHeight = configurationLines();
  wrongHeight[2] = wrongHeight[2].replace("relative_height_cm=-20", "relative_height_cm=-19");
  assert.throws(() => parseConfiguration(wrongHeight), /relative heights/);

  const unconfigured = parseConfiguration(configurationLines([], "unconfigured"));
  assert.equal(unconfigured.probes.length, 0);
});

test("connect and warm selection helpers reject ambiguous identity", () => {
  assert.equal(oneAddedRom(ROMS.slice(0, 2), ROMS.slice(0, 3)), ROMS[2]);
  assert.throws(() => oneAddedRom(ROMS.slice(0, 2), ROMS.slice(0, 2)), /found 0/);
  assert.throws(() => oneAddedRom(ROMS.slice(0, 2), ROMS.slice(1, 3)), /disappeared/);

  const baselines = Object.fromEntries(ROMS.map((rom) => [rom, 20]));
  const temperatures = { ...baselines, [ROMS[0]]: 23, [ROMS[1]]: 22 };
  assert.equal(selectWarmedProbe(temperatures, baselines).rom, ROMS[0]);
  temperatures[ROMS[1]] = 22.1;
  assert.equal(selectWarmedProbe(temperatures, baselines), null);
  temperatures[ROMS[0]] = 30;
  temperatures[ROMS[1]] = 24;
  assert.equal(selectWarmedProbe(temperatures, baselines, [ROMS[0]]).rom, ROMS[1]);
});
