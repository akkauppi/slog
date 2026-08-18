// Sauna logger commissioning protocol, version 1.
//
// This module deliberately has no browser dependencies. The same validation is
// used by the Web Serial client and by Node's built-in test runner.

export const PROTOCOL_VERSION = 1;
export const EXPECTED_PRODUCT = "sauna_logger";
export const EXPECTED_PARTITION = "sauna_ota_v1";
export const EXPECTED_OTA_SLOTS = Object.freeze(["app0", "app1"]);
export const EXPECTED_SENSORS = 8;
export const GEOMETRY_ID = "column8_20cm_v1";
export const MINIMUM_RISE_C = 3.0;
export const WINNER_MARGIN_C = 1.0;
export const MAXIMUM_LINE_LENGTH = 512;

const MESSAGE_NAME = /^[A-Z][A-Z0-9_]*$/;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const ROM_TEXT = /^[0-9A-Fa-f]{16}$/;
const CRC32_TEXT = /^[0-9A-Fa-f]{8}$/;
const FLOAT_TEXT = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

export class ProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

export class DeviceError extends Error {
  constructor(message) {
    const command = message?.fields?.command ?? "unknown";
    const code = message?.fields?.code ?? "unknown";
    super(`device refused ${command}: ${code}`);
    this.name = "DeviceError";
    this.command = command;
    this.code = code;
    this.messageName = message?.name ?? "UNKNOWN_ERROR";
    this.fields = Object.freeze({ ...(message?.fields ?? {}) });
  }
}

function asciiOnly(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

export function parseLine(line) {
  if (typeof line !== "string") {
    throw new ProtocolError("protocol line must be a string");
  }
  const text = line.replace(/[\r\n]+$/, "");
  if (!text) throw new ProtocolError("empty protocol line");
  if (text.length > MAXIMUM_LINE_LENGTH) {
    throw new ProtocolError("protocol line is too long");
  }
  if (!asciiOnly(text)) throw new ProtocolError("protocol line is not ASCII");

  const tokens = text.trim().split(/\s+/);
  const name = tokens[0];
  if (!MESSAGE_NAME.test(name)) {
    throw new ProtocolError(`invalid message name: ${JSON.stringify(name)}`);
  }

  const fields = Object.create(null);
  for (const token of tokens.slice(1)) {
    const separator = token.indexOf("=");
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? "" : token.slice(separator + 1);
    if (separator < 1 || !value || !FIELD_NAME.test(key)) {
      throw new ProtocolError(`invalid protocol field: ${JSON.stringify(token)}`);
    }
    if (Object.hasOwn(fields, key)) {
      throw new ProtocolError(`duplicate protocol field: ${key}`);
    }
    fields[key] = value;
  }
  return Object.freeze({ name, fields: Object.freeze(fields) });
}

function asMessage(value) {
  return typeof value === "string" ? parseLine(value) : value;
}

function required(message, field) {
  if (!message?.fields || !Object.hasOwn(message.fields, field)) {
    throw new ProtocolError(`${message?.name ?? "message"} is missing ${field}`);
  }
  return message.fields[field];
}

function unsigned(message, field) {
  const value = required(message, field);
  if (!/^[0-9]+$/.test(value)) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError(`${message.name} has unsafe ${field}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function booleanField(message, field) {
  const value = unsigned(message, field);
  if (value !== 0 && value !== 1) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value === 1;
}

function signed(message, field) {
  const value = required(message, field);
  if (!/^-?[0-9]+$/.test(value)) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError(`${message.name} has unsafe ${field}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function crc32(message, field = "crc32") {
  const value = required(message, field).toUpperCase();
  if (!CRC32_TEXT.test(value)) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function maximCrc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    let value = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mix = (crc ^ value) & 1;
      crc >>>= 1;
      if (mix) crc ^= 0x8c;
      value >>>= 1;
    }
  }
  return crc;
}

export function normalizeRom(value) {
  if (typeof value !== "string" || !ROM_TEXT.test(value)) {
    throw new ProtocolError(`invalid 1-Wire ROM syntax: ${JSON.stringify(value)}`);
  }
  const bytes = Uint8Array.from(
    value.match(/../g).map((pair) => Number.parseInt(pair, 16)),
  );
  if (bytes[0] !== 0x28) {
    throw new ProtocolError(
      `unsupported 1-Wire family: ${bytes[0].toString(16).toUpperCase().padStart(2, "0")}`,
    );
  }
  if (maximCrc8(bytes.subarray(0, 7)) !== bytes[7]) {
    throw new ProtocolError(`invalid 1-Wire ROM CRC: ${value.toUpperCase()}`);
  }
  return value.toUpperCase();
}

export function validateMapping(roms) {
  if (!Array.isArray(roms) || roms.length !== EXPECTED_SENSORS) {
    throw new ProtocolError(
      `expected ${EXPECTED_SENSORS} mapped probes, found ${roms?.length ?? 0}`,
    );
  }
  const normalized = roms.map(normalizeRom);
  if (new Set(normalized).size !== EXPECTED_SENSORS) {
    throw new ProtocolError("probe mapping contains duplicate ROM addresses");
  }
  return Object.freeze(normalized);
}

export function parseDeviceInfo(value) {
  const message = asMessage(value);
  if (message.name !== "SYS_INFO") {
    throw new ProtocolError(`expected SYS_INFO, found ${message.name}`);
  }
  return Object.freeze({
    protocol: unsigned(message, "protocol"),
    product: required(message, "product"),
    firmware: required(message, "firmware"),
    commit: required(message, "commit"),
    partition: required(message, "partition"),
    ota: required(message, "ota"),
    configured: booleanField(message, "configured"),
    activeGeneration: unsigned(message, "active_generation"),
    restartRequired: booleanField(message, "restart_required"),
    commissioning: booleanField(message, "commissioning"),
  });
}

export function requireCompatibleDevice(info) {
  if (info.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `device protocol ${info.protocol} is not supported; this portal supports ${PROTOCOL_VERSION}`,
    );
  }
  if (info.product !== EXPECTED_PRODUCT) {
    throw new ProtocolError(
      `unexpected device product ${JSON.stringify(info.product)}; expected ${JSON.stringify(EXPECTED_PRODUCT)}`,
    );
  }
  if (info.partition !== EXPECTED_PARTITION) {
    throw new ProtocolError(
      `unexpected partition layout ${JSON.stringify(info.partition)}; expected ${JSON.stringify(EXPECTED_PARTITION)}`,
    );
  }
  if (!EXPECTED_OTA_SLOTS.includes(info.ota)) {
    throw new ProtocolError(
      `unexpected running OTA slot ${JSON.stringify(info.ota)}; expected ${EXPECTED_OTA_SLOTS.join(", ")}`,
    );
  }
  return info;
}

export function requireActiveGeneration(info, expectedGeneration) {
  if (!info.configured) {
    throw new ProtocolError("logger rebooted without an active probe configuration");
  }
  if (info.restartRequired) {
    throw new ProtocolError("logger still reports that a restart is required");
  }
  if (info.commissioning) {
    throw new ProtocolError("logger still has autonomous logging suspended");
  }
  if (info.activeGeneration !== expectedGeneration) {
    throw new ProtocolError(
      `logger activated configuration generation ${info.activeGeneration}, expected ${expectedGeneration}`,
    );
  }
  return info;
}

function messagesWithoutChatter(values) {
  const result = [];
  for (const value of values) {
    const message = asMessage(value);
    if (message.name === "TELEM") continue;
    if (message.name === "CFG_ERROR" || message.name === "SYS_ERROR") {
      throw new DeviceError(message);
    }
    result.push(message);
  }
  return result;
}

function temperature(message) {
  const value = required(message, "temperature_c");
  if (value === "NA") return null;
  if (!FLOAT_TEXT.test(value)) {
    throw new ProtocolError(`invalid temperature: ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -55 || parsed > 125) {
    throw new ProtocolError(`temperature is outside DS18B20 range: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseScan(values) {
  const messages = messagesWithoutChatter(values);
  if (messages.length < 2 || messages[0].name !== "CFG_SCAN_BEGIN") {
    throw new ProtocolError("scan response is missing CFG_SCAN_BEGIN");
  }
  if (messages.at(-1).name !== "CFG_SCAN_END") {
    throw new ProtocolError("scan response is missing CFG_SCAN_END");
  }

  const beginCount = unsigned(messages[0], "count");
  const busCount = unsigned(messages[0], "bus_count");
  const overflow = booleanField(messages[0], "overflow");
  const endCount = unsigned(messages.at(-1), "count");
  const probes = messages.slice(1, -1).map((message) => {
    if (message.name !== "CFG_SCAN_SENSOR") {
      throw new ProtocolError(`unexpected message in scan: ${message.name}`);
    }
    const mappedPosition = unsigned(message, "mapped_position");
    if (mappedPosition > EXPECTED_SENSORS) {
      throw new ProtocolError(`CFG_SCAN_SENSOR has invalid mapped_position: ${mappedPosition}`);
    }
    return Object.freeze({
      rom: normalizeRom(required(message, "rom")),
      temperatureC: temperature(message),
      mappedPosition,
    });
  });

  if (beginCount !== probes.length || endCount !== probes.length) {
    throw new ProtocolError(
      `scan count does not match its begin/end framing (${beginCount}/${probes.length}/${endCount})`,
    );
  }
  if (beginCount > busCount) {
    throw new ProtocolError(
      `scan reports ${beginCount} usable probes on a ${busCount}-probe bus`,
    );
  }
  if (new Set(probes.map((probe) => probe.rom)).size !== probes.length) {
    throw new ProtocolError("scan contains a duplicate ROM address");
  }
  return Object.freeze({ probes: Object.freeze(probes), busCount, overflow });
}

export function parseConfiguration(values) {
  const messages = messagesWithoutChatter(values);
  if (messages.length < 2 || messages[0].name !== "CFG_GET_BEGIN") {
    throw new ProtocolError("configuration response is missing CFG_GET_BEGIN");
  }
  if (messages.at(-1).name !== "CFG_GET_END") {
    throw new ProtocolError("configuration response is missing CFG_GET_END");
  }

  const begin = messages[0];
  const end = messages.at(-1);
  const state = required(begin, "state");
  if (!["unconfigured", "valid", "invalid"].includes(state)) {
    throw new ProtocolError(`unknown configuration state: ${JSON.stringify(state)}`);
  }
  const generation = unsigned(begin, "generation");
  const geometry = required(begin, "geometry");
  const expectedCount = unsigned(begin, "count");
  const validSlots = unsigned(begin, "valid_slots");
  const detail = required(begin, "detail");
  const restartRequired = booleanField(begin, "restart_required");
  const endCount = unsigned(end, "count");
  const checksum = crc32(end);

  const probes = messages.slice(1, -1).map((message) => {
    if (message.name !== "CFG_MAP") {
      throw new ProtocolError(`unexpected message in configuration: ${message.name}`);
    }
    return Object.freeze({
      position: unsigned(message, "position"),
      relativeHeightCm: signed(message, "relative_height_cm"),
      rom: normalizeRom(required(message, "rom")),
    });
  });

  if (expectedCount !== probes.length || endCount !== probes.length) {
    throw new ProtocolError(
      `configuration count does not match its begin/end framing (${expectedCount}/${probes.length}/${endCount})`,
    );
  }
  const expectedPositions = probes.map((_, index) => index + 1);
  if (probes.some((probe, index) => probe.position !== expectedPositions[index])) {
    throw new ProtocolError("configuration positions are missing, duplicated, or unordered");
  }
  if (new Set(probes.map((probe) => probe.rom)).size !== probes.length) {
    throw new ProtocolError("configuration contains a duplicate ROM address");
  }
  if (state === "valid") {
    if (generation === 0) {
      throw new ProtocolError("valid configuration has generation zero");
    }
    if (geometry !== GEOMETRY_ID) {
      throw new ProtocolError(`unsupported configuration geometry: ${JSON.stringify(geometry)}`);
    }
    validateMapping(probes.map((probe) => probe.rom));
    if (probes.some((probe, index) => probe.relativeHeightCm !== -20 * index)) {
      throw new ProtocolError("configuration contains unexpected relative heights");
    }
  } else if (probes.length) {
    throw new ProtocolError(`${state} configuration unexpectedly contains a mapping`);
  }

  return Object.freeze({
    state,
    generation,
    geometry,
    probes: Object.freeze(probes),
    crc32: checksum,
    validSlots,
    detail,
    restartRequired,
  });
}

export function parseCommitAck(value) {
  const message = asMessage(value);
  requireSuccessfulAck(message, "CFG_COMMIT");
  const generation = unsigned(message, "generation");
  if (generation === 0) {
    throw new ProtocolError("CFG_COMMIT has generation zero");
  }
  return Object.freeze({
    generation,
    crc32: crc32(message),
    rebootRequired: booleanField(message, "reboot_required"),
  });
}

export function parseAbortAck(value) {
  const message = asMessage(value);
  requireSuccessfulAck(message, "CFG_ABORT");
  return Object.freeze({ restartRequired: booleanField(message, "restart_required") });
}

export function requireSuccessfulAck(value, expectedName) {
  const message = asMessage(value);
  if (message.name !== expectedName) {
    throw new ProtocolError(`expected ${expectedName}, found ${message.name}`);
  }
  if (required(message, "ok") !== "1") {
    throw new ProtocolError(`${expectedName} did not confirm success`);
  }
  return message;
}

export function oneAddedRom(previous, current) {
  const before = new Set(Array.from(previous, normalizeRom));
  const after = new Set(Array.from(current, normalizeRom));
  const missing = [...before].filter((rom) => !after.has(rom));
  const added = [...after].filter((rom) => !before.has(rom));
  if (missing.length) {
    throw new ProtocolError(`previously connected probe(s) disappeared: ${missing.sort().join(", ")}`);
  }
  if (added.length !== 1) {
    throw new ProtocolError(`expected exactly one new probe, found ${added.length}`);
  }
  return added[0];
}

export function strongestWarming(temperatures, baselines, alreadyMapped = []) {
  const mapped = new Set(Array.from(alreadyMapped, normalizeRom));
  const rises = [];
  for (const [value, reading] of Object.entries(temperatures)) {
    const rom = normalizeRom(value);
    if (reading == null || mapped.has(rom) || !Object.hasOwn(baselines, rom)) continue;
    rises.push({ riseC: reading - baselines[rom], rom, temperatureC: reading });
  }
  if (!rises.length) return null;
  rises.sort((left, right) => right.riseC - left.riseC || right.rom.localeCompare(left.rom));
  const winner = rises[0];
  const secondRise = rises[1]?.riseC ?? 0;
  return Object.freeze({ ...winner, marginC: winner.riseC - secondRise });
}

export function selectWarmedProbe(temperatures, baselines, alreadyMapped = []) {
  const candidate = strongestWarming(temperatures, baselines, alreadyMapped);
  if (
    candidate &&
    candidate.riseC >= MINIMUM_RISE_C &&
    candidate.marginC >= WINNER_MARGIN_C
  ) {
    return candidate;
  }
  return null;
}
