const MEBIBYTE = 1024 * 1024;

const EXPECTED_PARTITIONS = Object.freeze([
  Object.freeze({ name: "nvs", type: "data", subtype: "nvs", offset: 0x9000, size: 0x5000, flags: 0 }),
  Object.freeze({ name: "otadata", type: "data", subtype: "ota", offset: 0xe000, size: 0x2000, flags: 0 }),
  Object.freeze({ name: "app0", type: "app", subtype: "ota_0", offset: 0x10000, size: 0x140000, flags: 0 }),
  Object.freeze({ name: "app1", type: "app", subtype: "ota_1", offset: 0x150000, size: 0x140000, flags: 0 }),
  Object.freeze({ name: "spiffs", type: "data", subtype: "spiffs", offset: 0x290000, size: 0x160000, flags: 0 }),
  Object.freeze({ name: "coredump", type: "data", subtype: "coredump", offset: 0x3f0000, size: 0x10000, flags: 0 }),
]);

const FILE_POLICY = Object.freeze([
  Object.freeze({ role: "bootloader", offset: 0x0, maximumSize: 0x8000 }),
  Object.freeze({ role: "partition_table", offset: 0x8000, exactSize: 0xc00 }),
  Object.freeze({ role: "ota_data", offset: 0xe000, exactSize: 0x2000 }),
  Object.freeze({ role: "application", offset: 0x10000, maximumSize: 0x140000 }),
]);

const PROTECTED_PARTITIONS = new Set(["nvs", "app1", "spiffs", "coredump"]);
export const FIRMWARE_MANIFEST_SCHEMA_VERSION = 2;
export const FIRMWARE_COMMISSIONING_PROTOCOL = 1;
const LEGACY_FIRMWARE_MANIFEST_SCHEMA_VERSION = 1;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
// Public bundle generation permits only a clean full commit. The browser also
// accepts an explicitly labelled local development build so the same guarded
// installer can be exercised before its release commit exists.
const SOURCE_COMMIT = /^(?:[0-9a-f]{40}(?:-dirty)?|unknown)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const FlashPhase = Object.freeze({
  IDLE: "idle",
  VALIDATING: "validating",
  READY_TO_CONNECT: "ready_to_connect",
  REQUESTING_PORT: "requesting_port",
  CONNECTING: "connecting",
  READY_TO_FLASH: "ready_to_flash",
  FLASHING: "flashing",
  VERIFYING: "verifying",
  WRITE_OUTCOME_UNCERTAIN: "write_outcome_uncertain",
  RESETTING: "resetting",
  RESET_OUTCOME_UNCERTAIN: "reset_outcome_uncertain",
  CLOSING: "closing",
  CLOSE_OUTCOME_UNCERTAIN: "close_outcome_uncertain",
  READY_FOR_COMMISSIONING: "ready_for_commissioning",
  CANCELING: "canceling",
  CANCELED: "canceled",
  FAILED: "failed",
});

export const FlashRetry = Object.freeze({
  NONE: "none",
  CONNECT: "connect",
  REFLASH_SAME_PACKAGE: "reflash_same_package",
  RESET: "reset",
  CLOSE: "close",
});

const UNSAFE_PHASES = new Set([
  FlashPhase.REQUESTING_PORT,
  FlashPhase.CONNECTING,
  FlashPhase.READY_TO_FLASH,
  FlashPhase.FLASHING,
  FlashPhase.VERIFYING,
  FlashPhase.WRITE_OUTCOME_UNCERTAIN,
  FlashPhase.RESETTING,
  FlashPhase.RESET_OUTCOME_UNCERTAIN,
  FlashPhase.CLOSING,
  FlashPhase.CLOSE_OUTCOME_UNCERTAIN,
  FlashPhase.CANCELING,
]);

export class FlashWorkflowError extends Error {
  constructor(code, message, { cause = undefined, phase = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FlashWorkflowError";
    this.code = code;
    this.phase = phase;
  }
}

function fail(code, message, options) {
  throw new FlashWorkflowError(code, message, options);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, keys, description) {
  if (!isObject(value)) fail("manifest-invalid", `${description} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("manifest-invalid", `${description} has unexpected or missing fields`);
  }
}

function requireInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("manifest-invalid", `${description} must be a non-negative integer`);
  }
  return value;
}

function safeRelativePath(path, description) {
  if (typeof path !== "string" || !/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) {
    fail("manifest-invalid", `${description} must be a simple relative path`);
  }
  const segments = path.slice(2).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("manifest-invalid", `${description} must not escape the firmware directory`);
  }
  return path;
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function cloneManifest(manifest) {
  const cloned = {
    schema_version: manifest.schema_version,
    product: manifest.product,
    release: { ...manifest.release },
    target: { ...manifest.target },
    partitions: manifest.partitions.map((partition) => ({ ...partition })),
    files: manifest.files.map((file) => ({ ...file })),
  };
  if (Object.hasOwn(manifest, "commissioning_protocol")) {
    cloned.commissioning_protocol = manifest.commissioning_protocol;
  }
  return cloned;
}

export function validateFirmwareManifest(
  manifest,
  { allowLegacyWriteRecovery = false } = {},
) {
  const legacy = manifest?.schema_version === LEGACY_FIRMWARE_MANIFEST_SCHEMA_VERSION;
  requireExactKeys(
    manifest,
    legacy
      ? ["schema_version", "product", "release", "target", "partitions", "files"]
      : ["schema_version", "commissioning_protocol", "product", "release", "target", "partitions", "files"],
    "manifest",
  );
  if (legacy && !allowLegacyWriteRecovery) {
    fail(
      "manifest-commissioning-protocol-unsupported",
      "legacy firmware does not declare the commissioning protocol required by this portal",
    );
  }
  if (!legacy && manifest.schema_version !== FIRMWARE_MANIFEST_SCHEMA_VERSION) {
    fail(
      "manifest-schema-unsupported",
      `only firmware manifest schema version ${FIRMWARE_MANIFEST_SCHEMA_VERSION} is supported`,
    );
  }
  if (
    !legacy &&
    manifest.commissioning_protocol !== FIRMWARE_COMMISSIONING_PROTOCOL
  ) {
    fail(
      "manifest-commissioning-protocol-unsupported",
      `firmware commissioning protocol ${String(manifest.commissioning_protocol)} is not supported`,
    );
  }
  if (manifest.product !== "sauna_logger") {
    fail("manifest-product-mismatch", "firmware manifest names the wrong product");
  }

  requireExactKeys(manifest.release, ["version", "source_commit"], "manifest release");
  if (typeof manifest.release.version !== "string" || !RELEASE_VERSION.test(manifest.release.version)) {
    fail("manifest-version-invalid", "firmware release version is invalid");
  }
  if (typeof manifest.release.source_commit !== "string" || !SOURCE_COMMIT.test(manifest.release.source_commit)) {
    fail("manifest-version-invalid", "firmware source commit is invalid");
  }

  requireExactKeys(
    manifest.target,
    ["chip", "board", "flash_mode", "flash_frequency", "flash_size", "partition_layout"],
    "manifest target",
  );
  const expectedTarget = {
    chip: "ESP32-C3",
    board: "seeed_xiao_esp32c3",
    flash_mode: "dio",
    flash_frequency: "80m",
    flash_size: 4 * MEBIBYTE,
    partition_layout: "sauna_ota_v1",
  };
  for (const [field, expected] of Object.entries(expectedTarget)) {
    if (manifest.target[field] !== expected) {
      fail("manifest-target-mismatch", `firmware target ${field} is not supported`);
    }
  }

  if (!Array.isArray(manifest.partitions) || manifest.partitions.length !== EXPECTED_PARTITIONS.length) {
    fail("manifest-partition-layout-mismatch", "firmware must use the exact supported partition table");
  }
  manifest.partitions.forEach((partition, index) => {
    requireExactKeys(partition, ["name", "type", "subtype", "offset", "size", "flags"], `partition ${index}`);
    const expected = EXPECTED_PARTITIONS[index];
    for (const field of Object.keys(expected)) {
      if (partition[field] !== expected[field]) {
        fail("manifest-partition-layout-mismatch", `partition ${index} does not match ${expected.name}`);
      }
    }
  });

  if (!Array.isArray(manifest.files) || manifest.files.length !== FILE_POLICY.length) {
    fail("manifest-files-invalid", "firmware manifest must contain exactly four flash images");
  }
  const normalized = cloneManifest(manifest);
  const urls = new Set();
  normalized.files.forEach((file, index) => {
    requireExactKeys(file, ["role", "path", "offset", "size", "sha256"], `flash image ${index}`);
    const policy = FILE_POLICY[index];
    if (file.role !== policy.role || file.offset !== policy.offset) {
      fail("manifest-files-invalid", `flash image ${index} must be ${policy.role} at 0x${policy.offset.toString(16)}`);
    }
    file.path = safeRelativePath(file.path, `${file.role} path`);
    if (urls.has(file.path)) fail("manifest-files-invalid", "flash image paths must be unique");
    urls.add(file.path);
    requireInteger(file.size, `${file.role} size`);
    if (file.size === 0) fail("manifest-files-invalid", `${file.role} must not be empty`);
    if (policy.exactSize !== undefined && file.size !== policy.exactSize) {
      fail("manifest-files-invalid", `${file.role} must be exactly ${policy.exactSize} bytes`);
    }
    if (policy.maximumSize !== undefined && file.size > policy.maximumSize) {
      fail("manifest-files-invalid", `${file.role} exceeds its preserved flash range`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      fail("manifest-files-invalid", `${file.role} has an invalid SHA-256 digest`);
    }
  });

  const protectedRanges = normalized.partitions.filter((partition) => PROTECTED_PARTITIONS.has(partition.name));
  for (const file of normalized.files) {
    const end = file.offset + file.size;
    if (!Number.isSafeInteger(end) || end > expectedTarget.flash_size) {
      fail("manifest-files-invalid", `${file.role} exceeds the device flash`);
    }
    for (const partition of protectedRanges) {
      if (rangesOverlap(file.offset, end, partition.offset, partition.offset + partition.size)) {
        fail("manifest-files-invalid", `${file.role} overlaps protected ${partition.name}`);
      }
    }
  }
  for (let index = 1; index < normalized.files.length; index += 1) {
    const previous = normalized.files[index - 1];
    const current = normalized.files[index];
    if (previous.offset + previous.size > current.offset) {
      fail("manifest-files-invalid", `${previous.role} overlaps ${current.role}`);
    }
  }
  return normalized;
}

function asBytes(value, description = "binary data") {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  fail("image-fetch-failed", `${description} is not binary data`);
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("digest-unavailable", "Web Crypto SHA-256 is unavailable");
  const bytes = asBytes(value);
  return hex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
);

function rotateLeft(value, amount) {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

export function md5Hex(value) {
  const input = asBytes(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(input.length) * 8n;
  view.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(paddedLength - 4, Number((bitLength >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let mixed;
      let wordIndex;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const nextD = d;
      d = c;
      c = b;
      const sum = (a + mixed + MD5_CONSTANTS[index] + words[wordIndex]) >>> 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index])) >>> 0;
      a = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const result = new Uint8Array(16);
  const resultView = new DataView(result.buffer);
  [a0, b0, c0, d0].forEach((word, index) => resultView.setUint32(index * 4, word, true));
  return hex(result);
}

function decodePartitionTable(data) {
  if (data.length !== 0xc00) fail("partition-binary-invalid", "partition table binary has the wrong size");
  const entries = [];
  let checksumSeen = false;
  for (let offset = 0; offset < data.length; offset += 32) {
    const record = data.subarray(offset, offset + 32);
    if (record[0] === 0xaa && record[1] === 0x50) {
      if (checksumSeen) fail("partition-binary-invalid", "partition entry follows its checksum");
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const zero = record.indexOf(0, 12);
      const labelEnd = zero < 0 || zero > 28 ? 28 : zero;
      const labelBytes = record.subarray(12, labelEnd);
      if (labelBytes.some((value) => value < 0x20 || value > 0x7e)) {
        fail("partition-binary-invalid", "partition label is not ASCII");
      }
      entries.push({
        name: String.fromCharCode(...labelBytes),
        typeValue: record[2],
        subtypeValue: record[3],
        offset: view.getUint32(4, true),
        size: view.getUint32(8, true),
        flags: view.getUint32(28, true),
      });
      continue;
    }
    const checksumHeader = record[0] === 0xeb && record[1] === 0xeb && record.subarray(2, 16).every((value) => value === 0xff);
    if (checksumHeader) {
      if (checksumSeen) fail("partition-binary-invalid", "partition table has multiple checksums");
      if (md5Hex(data.subarray(0, offset)) !== hex(record.subarray(16))) {
        fail("partition-binary-invalid", "partition table MD5 does not match");
      }
      checksumSeen = true;
      continue;
    }
    if (!record.every((value) => value === 0xff)) {
      fail("partition-binary-invalid", `invalid partition record at 0x${offset.toString(16)}`);
    }
  }
  if (!checksumSeen) fail("partition-binary-invalid", "partition table has no MD5 checksum");
  return entries;
}

function validatePartitionBinary(data) {
  const entries = decodePartitionTable(data);
  if (entries.length !== EXPECTED_PARTITIONS.length) {
    fail("partition-binary-invalid", "partition binary does not contain the exact supported layout");
  }
  entries.forEach((entry, index) => {
    const expected = EXPECTED_PARTITIONS[index];
    const typeValue = expected.type === "app" ? 0 : 1;
    const subtypeValue = {
      nvs: 0x02,
      ota: 0x00,
      ota_0: 0x10,
      ota_1: 0x11,
      spiffs: 0x82,
      coredump: 0x03,
    }[expected.subtype];
    if (
      entry.name !== expected.name || entry.typeValue !== typeValue ||
      entry.subtypeValue !== subtypeValue || entry.offset !== expected.offset ||
      entry.size !== expected.size || entry.flags !== expected.flags
    ) {
      fail("partition-binary-invalid", `partition binary entry ${index} does not match ${expected.name}`);
    }
  });
}

async function fetchBinary(url) {
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin" });
  } catch (cause) {
    fail("image-fetch-failed", `could not fetch ${url.pathname}`, { cause });
  }
  if (!response.ok) fail("image-fetch-failed", `firmware image request failed with HTTP ${response.status}`);
  return response.arrayBuffer();
}

function absoluteManifestUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (cause) {
    fail("manifest-invalid", "manifestUrl must be an absolute HTTP(S) URL", { cause });
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("manifest-invalid", "manifestUrl must be a clean absolute HTTP(S) URL");
  }
  return url;
}

async function checkedDigest(digest, data) {
  const value = await digest(data);
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("digest-invalid", "SHA-256 implementation returned an invalid digest");
  }
  return value;
}

export async function prepareFirmwarePackage(
  manifest,
  {
    manifestUrl,
    loadFile = fetchBinary,
    digest = sha256Hex,
    allowLegacyWriteRecovery = false,
  } = {},
) {
  const normalized = validateFirmwareManifest(manifest, {
    allowLegacyWriteRecovery,
  });
  const base = absoluteManifestUrl(manifestUrl);
  if (typeof loadFile !== "function" || typeof digest !== "function") {
    fail("manifest-invalid", "loadFile and digest must be functions");
  }
  const baseDirectory = new URL("./", base);
  const files = [];
  for (const file of normalized.files) {
    const url = new URL(file.path, base);
    if (url.origin !== baseDirectory.origin || !url.href.startsWith(baseDirectory.href)) {
      fail("manifest-invalid", `${file.role} path escapes the manifest directory`);
    }
    let loaded;
    try {
      loaded = await loadFile(url, { ...file });
    } catch (cause) {
      if (cause instanceof FlashWorkflowError) throw cause;
      fail("image-fetch-failed", `could not load ${file.role}`, { cause });
    }
    const data = asBytes(loaded, `${file.role} image`);
    if (data.length !== file.size) {
      fail("image-size-mismatch", `${file.role} has ${data.length} bytes, expected ${file.size}`);
    }
    if (await checkedDigest(digest, data) !== file.sha256) {
      fail("image-hash-mismatch", `${file.role} failed its SHA-256 check`);
    }
    if (file.role === "partition_table") validatePartitionBinary(data);
    files.push({ ...file, url: url.href, data });
  }
  const identity = new TextEncoder().encode(JSON.stringify(normalized));
  const packageSha256 = await checkedDigest(digest, identity);
  return {
    manifest: normalized,
    manifestUrl: base.href,
    files,
    packageSha256,
    digest,
    legacyWriteRecovery: Boolean(allowLegacyWriteRecovery && normalized.schema_version === 1),
  };
}

async function verifyPreparedPackage(prepared) {
  validateFirmwareManifest(prepared.manifest, {
    allowLegacyWriteRecovery: prepared.legacyWriteRecovery === true,
  });
  for (const file of prepared.files) {
    if (file.data.length !== file.size) fail("image-size-mismatch", `${file.role} changed after validation`);
    if (await checkedDigest(prepared.digest, file.data) !== file.sha256) {
      fail("image-hash-mismatch", `${file.role} changed after validation`);
    }
    if (file.role === "partition_table") validatePartitionBinary(file.data);
  }
}

function publicPrepared(prepared) {
  if (!prepared) return null;
  return {
    manifest: cloneManifest(prepared.manifest),
    release: { ...prepared.manifest.release },
    target: { ...prepared.manifest.target },
    files: prepared.files.map(({ role, path, offset, size, sha256 }) => ({ role, path, offset, size, sha256 })),
    packageSha256: prepared.packageSha256,
  };
}

function publicError(error) {
  return error ? { name: error.name, code: error.code ?? "unknown", message: error.message } : null;
}

function normalizeError(error, code, message, phase) {
  return error instanceof FlashWorkflowError
    ? error
    : new FlashWorkflowError(code, message, { cause: error, phase });
}

function normalizeConnectError(error) {
  if (error instanceof FlashWorkflowError) return error;
  const adapterCode =
    error?.name === "EsptoolAdapterError" && typeof error.code === "string"
      ? error.code
      : "connect-failed";
  return new FlashWorkflowError(
    adapterCode,
    error?.message || "could not connect to the ESP bootloader",
    { cause: error, phase: FlashPhase.CONNECTING },
  );
}

export class BrowserFlashController {
  #adapter;
  #requestPort;
  #onStateChange;
  #onDiagnostic;
  #phase = FlashPhase.IDLE;
  #retry = FlashRetry.NONE;
  #error = null;
  #prepared = null;
  #port = null;
  #chip = null;
  #deviceIdHash = null;
  #expectedRecoveryDeviceIdHash = null;
  #running = false;
  #adapterMayBeOpen = false;
  #writeMayHaveStarted = false;
  #recoveryRequired = false;
  #recoverySessionReady = false;
  #afterClose = null;
  #afterResetPhase = null;
  #progress = null;

  constructor({ adapter, requestPort, onStateChange = null, onDiagnostic = null }) {
    for (const method of ["connect", "write", "reset", "close"]) {
      if (typeof adapter?.[method] !== "function") throw new TypeError(`adapter.${method} must be a function`);
    }
    if (typeof requestPort !== "function") throw new TypeError("requestPort must be a function");
    if (onStateChange !== null && typeof onStateChange !== "function") throw new TypeError("onStateChange must be a function");
    if (onDiagnostic !== null && typeof onDiagnostic !== "function") throw new TypeError("onDiagnostic must be a function");
    this.#adapter = adapter;
    this.#requestPort = requestPort;
    this.#onStateChange = onStateChange;
    this.#onDiagnostic = onDiagnostic;
  }

  get snapshot() {
    return {
      phase: this.#phase,
      retry: this.#retry,
      unsafeToUnload: this.#recoveryRequired || UNSAFE_PHASES.has(this.#phase),
      canCancel:
        this.#phase === FlashPhase.READY_TO_FLASH &&
        !this.#writeMayHaveStarted &&
        !this.#recoveryRequired,
      writeMayHaveStarted: this.#writeMayHaveStarted,
      chip: this.#chip,
      deviceIdHash: this.#deviceIdHash,
      progress: this.#progress ? { ...this.#progress } : null,
      error: publicError(this.#error),
      prepared: publicPrepared(this.#prepared),
    };
  }

  #transition(phase, { retry = FlashRetry.NONE, error = null } = {}) {
    this.#phase = phase;
    this.#retry = retry;
    this.#error = error;
    try { this.#onStateChange?.(this.snapshot); } catch { /* UI callbacks cannot alter safety. */ }
    this.#diagnostic({ type: "phase", phase, retry, error: publicError(error) });
  }

  #diagnostic(entry) {
    try { this.#onDiagnostic?.({ source: "flasher", ...entry }); } catch { /* Diagnostics cannot alter safety. */ }
  }

  async #exclusive(operation) {
    if (this.#running) fail("operation-in-progress", "another flashing operation is already running", { phase: this.#phase });
    this.#running = true;
    try { return await operation(); } finally { this.#running = false; }
  }

  #requirePhase(...phases) {
    if (!phases.includes(this.#phase)) {
      fail("invalid-state", `operation is not available while flashing is ${this.#phase}`, { phase: this.#phase });
    }
  }

  async prepare(manifest, options) {
    return this.#exclusive(async () => {
      this.#requirePhase(FlashPhase.IDLE, FlashPhase.FAILED, FlashPhase.CANCELED);
      if (this.#writeMayHaveStarted || this.#adapterMayBeOpen) {
        fail("invalid-state", "a new package cannot replace an active or uncertain installation", { phase: this.#phase });
      }
      this.#transition(FlashPhase.VALIDATING);
      try {
        this.#prepared = await prepareFirmwarePackage(manifest, options);
        this.#port = null;
        this.#chip = null;
        this.#deviceIdHash = null;
        this.#expectedRecoveryDeviceIdHash = null;
        this.#progress = null;
        this.#recoveryRequired = false;
        this.#recoverySessionReady = false;
        this.#afterClose = null;
        this.#afterResetPhase = null;
        this.#transition(FlashPhase.READY_TO_CONNECT);
        return publicPrepared(this.#prepared);
      } catch (error) {
        const normalized = normalizeError(error, "manifest-invalid", "firmware package validation failed", FlashPhase.VALIDATING);
        this.#prepared = null;
        this.#transition(FlashPhase.FAILED, { error: normalized });
        throw normalized;
      }
    });
  }

  markRecoveryRequired(expectedPackageSha256, expectedDeviceIdHash) {
    this.#requirePhase(FlashPhase.READY_TO_CONNECT);
    if (this.#running) {
      fail("operation-in-progress", "package validation is still running", { phase: this.#phase });
    }
    if (typeof expectedPackageSha256 !== "string" || !SHA256.test(expectedPackageSha256)) {
      fail("recovery-package-mismatch", "recovery marker does not contain a valid package identity", { phase: this.#phase });
    }
    if (expectedPackageSha256 !== this.#prepared?.packageSha256) {
      fail("recovery-package-mismatch", "the prepared package differs from the interrupted installation", { phase: this.#phase });
    }
    if (typeof expectedDeviceIdHash !== "string" || !SHA256.test(expectedDeviceIdHash)) {
      fail(
        "recovery-device-mismatch",
        "recovery marker does not contain a valid hashed device identity",
        { phase: this.#phase },
      );
    }
    this.#writeMayHaveStarted = true;
    this.#recoveryRequired = true;
    this.#expectedRecoveryDeviceIdHash = expectedDeviceIdHash;
    this.#diagnostic({
      type: "recovery_required",
      packageSha256: expectedPackageSha256,
      deviceIdHash: expectedDeviceIdHash,
    });
    return this.snapshot;
  }

  #acceptConnectedTarget(result) {
    this.#chip = result?.chip ?? null;
    if (this.#chip !== "ESP32-C3") {
      fail(
        "chip-mismatch",
        `selected device reports ${this.#chip ?? "an unknown chip"}, not ESP32-C3`,
        { phase: FlashPhase.CONNECTING },
      );
    }
    if (result?.flashSize !== "4MB") {
      fail(
        "target-flash-size-mismatch",
        "selected ESP32-C3 does not report the required 4MB flash",
        { phase: FlashPhase.CONNECTING },
      );
    }
    const deviceIdHash = result?.deviceIdHash;
    if (typeof deviceIdHash !== "string" || !SHA256.test(deviceIdHash)) {
      fail(
        "target-device-identity-invalid",
        "selected ESP32-C3 did not provide a valid hashed identity",
        { phase: FlashPhase.CONNECTING },
      );
    }
    if (
      this.#expectedRecoveryDeviceIdHash &&
      deviceIdHash !== this.#expectedRecoveryDeviceIdHash
    ) {
      fail(
        "device-mismatch",
        "selected ESP32-C3 is not the device bound to this recovery",
        { phase: FlashPhase.CONNECTING },
      );
    }
    this.#deviceIdHash = deviceIdHash;
  }

  async connect() {
    return this.#exclusive(async () => {
      this.#requirePhase(FlashPhase.READY_TO_CONNECT);
      this.#transition(FlashPhase.REQUESTING_PORT);
      try {
        this.#port = await this.#requestPort();
      } catch (error) {
        this.#port = null;
        this.#transition(FlashPhase.READY_TO_CONNECT);
        throw error;
      }
      this.#transition(FlashPhase.CONNECTING);
      this.#adapterMayBeOpen = true;
      let result;
      try {
        result = await this.#adapter.connect(this.#port);
      } catch (cause) {
        const error = normalizeConnectError(cause);
        return this.#rejectConnectedSelection(error);
      }
      try {
        this.#acceptConnectedTarget(result);
      } catch (error) {
        return this.#rejectConnectedSelection(error);
      }
      if (this.#recoveryRequired) {
        this.#recoverySessionReady = true;
        const recovery = new FlashWorkflowError(
          "recovery-required",
          "the same verified package must be written again before this installation is trusted",
          { phase: FlashPhase.WRITE_OUTCOME_UNCERTAIN },
        );
        this.#transition(FlashPhase.WRITE_OUTCOME_UNCERTAIN, {
          retry: FlashRetry.REFLASH_SAME_PACKAGE,
          error: recovery,
        });
        return this.snapshot;
      }
      this.#transition(FlashPhase.READY_TO_FLASH);
      return this.snapshot;
    });
  }

  async #rejectConnectedSelection(primaryError) {
    let resetError = null;
    try { await this.#adapter.reset(); } catch (error) { resetError = error; }
    let closeError = null;
    try {
      await this.#adapter.close();
      this.#adapterMayBeOpen = false;
    } catch (cause) {
      closeError = cause;
    }
    this.#recoverySessionReady = false;
    if (closeError) {
      const resetOutcome = resetError
        ? normalizeError(resetError, "reset-outcome-uncertain", "device reset could not be confirmed", FlashPhase.RESETTING)
        : null;
      this.#afterResetPhase = resetError ? FlashPhase.READY_TO_CONNECT : null;
      this.#afterClose = resetError
        ? { phase: FlashPhase.RESET_OUTCOME_UNCERTAIN, retry: FlashRetry.RESET, error: resetOutcome }
        : { phase: FlashPhase.FAILED, retry: FlashRetry.CONNECT, error: primaryError };
      const error = new FlashWorkflowError(
        "close-outcome-uncertain",
        "the rejected bootloader transport may still be open",
        {
          cause: new AggregateError([primaryError, resetError, closeError].filter(Boolean)),
          phase: FlashPhase.CLOSE_OUTCOME_UNCERTAIN,
        },
      );
      this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
        retry: FlashRetry.CLOSE,
        error,
      });
      throw error;
    }
    this.#port = null;
    if (resetError) {
      const error = normalizeError(resetError, "reset-outcome-uncertain", "device reset could not be confirmed", FlashPhase.RESETTING);
      this.#afterResetPhase = FlashPhase.READY_TO_CONNECT;
      this.#transition(FlashPhase.RESET_OUTCOME_UNCERTAIN, {
        retry: FlashRetry.RESET,
        error,
      });
      throw error;
    }
    this.#transition(FlashPhase.FAILED, {
      retry: FlashRetry.CONNECT,
      error: primaryError,
    });
    throw primaryError;
  }

  async cancel() {
    return this.#exclusive(async () => {
      this.#requirePhase(FlashPhase.READY_TO_FLASH);
      this.#expectedRecoveryDeviceIdHash ??= this.#deviceIdHash;
      this.#transition(FlashPhase.CANCELING);
      let resetError = null;
      try { await this.#adapter.reset(); } catch (error) { resetError = error; }
      this.#transition(FlashPhase.CLOSING);
      try {
        await this.#adapter.close();
        this.#adapterMayBeOpen = false;
      } catch (cause) {
        const error = new FlashWorkflowError("close-outcome-uncertain", "could not close the bootloader transport", { cause, phase: FlashPhase.CLOSING });
        if (resetError) this.#afterResetPhase = FlashPhase.CANCELED;
        this.#afterClose = resetError
          ? {
              phase: FlashPhase.RESET_OUTCOME_UNCERTAIN,
              retry: FlashRetry.RESET,
              error: normalizeError(resetError, "reset-outcome-uncertain", "device reset could not be confirmed", FlashPhase.RESETTING),
            }
          : { phase: FlashPhase.CANCELED, retry: FlashRetry.NONE, error: null };
        this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, { retry: FlashRetry.CLOSE, error });
        throw error;
      }
      if (resetError) {
        const error = normalizeError(resetError, "reset-outcome-uncertain", "device reset could not be confirmed", FlashPhase.RESETTING);
        this.#afterResetPhase = FlashPhase.CANCELED;
        this.#transition(FlashPhase.RESET_OUTCOME_UNCERTAIN, { retry: FlashRetry.RESET, error });
        throw error;
      }
      this.#transition(FlashPhase.CANCELED);
      return { port: this.#port, snapshot: this.snapshot };
    });
  }

  async disconnect() { return this.cancel(); }

  async flash({ onProgress = null, beforeWrite = null } = {}) {
    return this.#exclusive(async () => {
      this.#requirePhase(FlashPhase.READY_TO_FLASH);
      return this.#performFlash(onProgress, beforeWrite);
    });
  }

  async #performFlash(onProgress, beforeWrite = null) {
    if (onProgress !== null && typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
    if (beforeWrite !== null && typeof beforeWrite !== "function") throw new TypeError("beforeWrite must be a function");
    await verifyPreparedPackage(this.#prepared);
    if (typeof this.#deviceIdHash !== "string" || !SHA256.test(this.#deviceIdHash)) {
      fail(
        "target-device-identity-invalid",
        "the connected target has no validated device identity",
        { phase: this.#phase },
      );
    }
    this.#expectedRecoveryDeviceIdHash ??= this.#deviceIdHash;
    // A recovery owner may need to atomically advance durable state only after
    // package and target preflight, but before the first adapter write. A
    // rejected gate is a definite pre-write failure and leaves cancellation
    // available.
    await beforeWrite?.({
      packageSha256: this.#prepared.packageSha256,
      deviceIdHash: this.#deviceIdHash,
    });
    const overallTotal = this.#prepared.files.reduce((sum, file) => sum + file.size, 0);
    this.#progress = { fileIndex: 1, fileCount: this.#prepared.files.length, fileRole: this.#prepared.files[0].role, written: 0, total: this.#prepared.files[0].size, overallWritten: 0, overallTotal };
    this.#writeMayHaveStarted = true;
    this.#transition(FlashPhase.FLASHING);
    const images = this.#prepared.files.map((file) => ({ role: file.role, address: file.offset, data: new Uint8Array(file.data) }));
    try {
      await this.#adapter.write(images, {
        onProgress: (fileIndex, written, total) => {
          const file = this.#prepared.files[fileIndex];
          if (!file || !Number.isFinite(written) || !Number.isFinite(total) || total <= 0) return;
          const completedBefore = this.#prepared.files.slice(0, fileIndex).reduce((sum, item) => sum + item.size, 0);
          const ratio = Math.max(0, Math.min(1, written / total));
          this.#progress = {
            fileIndex: fileIndex + 1,
            fileCount: this.#prepared.files.length,
            fileRole: file.role,
            written,
            total,
            overallWritten: Math.round(completedBefore + file.size * ratio),
            overallTotal,
          };
          this.#diagnostic({ type: "progress", ...this.#progress });
          if (fileIndex === this.#prepared.files.length - 1 && ratio === 1) this.#transition(FlashPhase.VERIFYING);
          try { onProgress?.({ ...this.#progress }); } catch { /* Progress rendering cannot interrupt flash. */ }
        },
      });
    } catch (cause) {
      const error = new FlashWorkflowError("flash-write-uncertain", "firmware write or device verification did not complete", { cause, phase: this.#phase });
      this.#recoveryRequired = true;
      this.#recoverySessionReady = false;
      try {
        await this.#adapter.close();
        this.#adapterMayBeOpen = false;
      } catch (closeCause) {
        this.#afterClose = {
          phase: FlashPhase.WRITE_OUTCOME_UNCERTAIN,
          retry: FlashRetry.REFLASH_SAME_PACKAGE,
          error,
        };
        const closeError = new FlashWorkflowError(
          "close-outcome-uncertain",
          "firmware outcome is uncertain and the old serial transport may still be open",
          { cause: closeCause, phase: FlashPhase.CLOSING },
        );
        this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
          retry: FlashRetry.CLOSE,
          error: closeError,
        });
        throw closeError;
      }
      this.#transition(FlashPhase.WRITE_OUTCOME_UNCERTAIN, { retry: FlashRetry.REFLASH_SAME_PACKAGE, error });
      throw error;
    }
    this.#transition(FlashPhase.RESETTING);
    try {
      await this.#adapter.reset();
    } catch (cause) {
      const error = new FlashWorkflowError("reset-outcome-uncertain", "firmware verified but reset could not be confirmed", { cause, phase: FlashPhase.RESETTING });
      this.#recoveryRequired = true;
      this.#afterResetPhase = FlashPhase.READY_FOR_COMMISSIONING;
      try {
        await this.#adapter.close();
        this.#adapterMayBeOpen = false;
      } catch (closeCause) {
        this.#afterClose = {
          phase: FlashPhase.RESET_OUTCOME_UNCERTAIN,
          retry: FlashRetry.RESET,
          error,
        };
        const closeError = new FlashWorkflowError(
          "close-outcome-uncertain",
          "firmware verified, but reset and transport close are uncertain",
          { cause: closeCause, phase: FlashPhase.CLOSING },
        );
        this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
          retry: FlashRetry.CLOSE,
          error: closeError,
        });
        throw closeError;
      }
      this.#transition(FlashPhase.RESET_OUTCOME_UNCERTAIN, { retry: FlashRetry.RESET, error });
      throw error;
    }
    this.#transition(FlashPhase.CLOSING);
    try {
      await this.#adapter.close();
      this.#adapterMayBeOpen = false;
    } catch (cause) {
      const error = new FlashWorkflowError("close-outcome-uncertain", "firmware verified and reset, but the serial port could not be released", { cause, phase: FlashPhase.CLOSING });
      this.#recoveryRequired = true;
      this.#afterClose = {
        phase: FlashPhase.READY_FOR_COMMISSIONING,
        retry: FlashRetry.NONE,
        error: null,
      };
      this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, { retry: FlashRetry.CLOSE, error });
      throw error;
    }
    this.#recoveryRequired = false;
    this.#recoverySessionReady = false;
    this.#transition(FlashPhase.READY_FOR_COMMISSIONING);
    return { port: this.#port, snapshot: this.snapshot };
  }

  async retry({ onProgress = null } = {}) {
    return this.#exclusive(async () => {
      const retry = this.#retry;
      if (retry === FlashRetry.NONE) this.#requirePhase("a retryable failure");
      if (retry === FlashRetry.CONNECT) {
        this.#adapterMayBeOpen = false;
        this.#port = null;
        this.#transition(FlashPhase.READY_TO_CONNECT);
        return this.snapshot;
      }
      if (retry === FlashRetry.CLOSE) {
        this.#transition(FlashPhase.CLOSING);
        try {
          await this.#adapter.close();
          this.#adapterMayBeOpen = false;
        } catch (cause) {
          const error = new FlashWorkflowError("close-outcome-uncertain", "serial transport still could not be released", { cause, phase: FlashPhase.CLOSING });
          this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, { retry: FlashRetry.CLOSE, error });
          throw error;
        }
        const next = this.#afterClose ?? {
          phase: this.#writeMayHaveStarted
            ? FlashPhase.READY_FOR_COMMISSIONING
            : FlashPhase.CANCELED,
          retry: FlashRetry.NONE,
          error: null,
        };
        this.#afterClose = null;
        if (next.phase !== FlashPhase.RESET_OUTCOME_UNCERTAIN) {
          this.#afterResetPhase = null;
        }
        if (next.phase === FlashPhase.READY_FOR_COMMISSIONING) {
          this.#recoveryRequired = false;
          this.#recoverySessionReady = false;
        }
        this.#transition(next.phase, { retry: next.retry, error: next.error });
        return { port: this.#port, snapshot: this.snapshot };
      }
      if (retry === FlashRetry.REFLASH_SAME_PACKAGE || retry === FlashRetry.RESET) {
        if (
          retry === FlashRetry.REFLASH_SAME_PACKAGE &&
          this.#recoverySessionReady &&
          this.#adapterMayBeOpen
        ) {
          this.#recoverySessionReady = false;
          return this.#performFlash(onProgress);
        }
        if (this.#adapterMayBeOpen) {
          try {
            await this.#adapter.close();
            this.#adapterMayBeOpen = false;
          } catch (cause) {
            const error = normalizeError(
              cause,
              "close-outcome-uncertain",
              "the previous recovery transport could not be released",
              FlashPhase.CLOSING,
            );
            this.#afterClose = {
              phase: retry === FlashRetry.REFLASH_SAME_PACKAGE
                ? FlashPhase.WRITE_OUTCOME_UNCERTAIN
                : FlashPhase.RESET_OUTCOME_UNCERTAIN,
              retry,
              error: this.#error,
            };
            this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
              retry: FlashRetry.CLOSE,
              error,
            });
            throw error;
          }
        }
        const uncertaintyPhase = retry === FlashRetry.REFLASH_SAME_PACKAGE
          ? FlashPhase.WRITE_OUTCOME_UNCERTAIN
          : FlashPhase.RESET_OUTCOME_UNCERTAIN;
        const recoveryError = this.#error;
        this.#transition(FlashPhase.REQUESTING_PORT);
        try {
          // This is deliberately a fresh chooser call. A board re-enumerated
          // after USB or power loss may not be represented by the old object.
          this.#port = await this.#requestPort();
        } catch (error) {
          this.#transition(uncertaintyPhase, { retry, error: recoveryError });
          throw error;
        }
        this.#transition(FlashPhase.CONNECTING);
        this.#adapterMayBeOpen = true;
        try {
          const result = await this.#adapter.connect(this.#port);
          this.#acceptConnectedTarget(result);
        } catch (cause) {
          const error = normalizeConnectError(cause);
          try {
            await this.#adapter.reset();
          } catch { /* The selected device never reached a trusted state. */ }
          try {
            await this.#adapter.close();
            this.#adapterMayBeOpen = false;
          } catch (closeCause) {
            const closeError = normalizeError(
              closeCause,
              "close-outcome-uncertain",
              "recovery connection could not be released",
              FlashPhase.CLOSING,
            );
            this.#afterClose = { phase: uncertaintyPhase, retry, error };
            this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
              retry: FlashRetry.CLOSE,
              error: closeError,
            });
            throw closeError;
          }
          this.#transition(uncertaintyPhase, { retry, error });
          throw error;
        }
        if (retry === FlashRetry.REFLASH_SAME_PACKAGE) return this.#performFlash(onProgress);
        this.#transition(FlashPhase.RESETTING);
        try { await this.#adapter.reset(); } catch (cause) {
          const error = normalizeError(cause, "reset-outcome-uncertain", "device reset still could not be confirmed", FlashPhase.RESETTING);
          try {
            await this.#adapter.close();
            this.#adapterMayBeOpen = false;
          } catch (closeCause) {
            const closeError = normalizeError(
              closeCause,
              "close-outcome-uncertain",
              "reset is uncertain and the recovery transport could not be released",
              FlashPhase.CLOSING,
            );
            this.#afterClose = {
              phase: FlashPhase.RESET_OUTCOME_UNCERTAIN,
              retry: FlashRetry.RESET,
              error,
            };
            this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, {
              retry: FlashRetry.CLOSE,
              error: closeError,
            });
            throw closeError;
          }
          this.#transition(FlashPhase.RESET_OUTCOME_UNCERTAIN, { retry: FlashRetry.RESET, error });
          throw error;
        }
        this.#transition(FlashPhase.CLOSING);
        try {
          await this.#adapter.close();
          this.#adapterMayBeOpen = false;
        } catch (cause) {
          const error = normalizeError(cause, "close-outcome-uncertain", "serial transport could not be released after reset", FlashPhase.CLOSING);
          const resetTerminal = this.#afterResetPhase ?? (
            this.#writeMayHaveStarted
              ? FlashPhase.READY_FOR_COMMISSIONING
              : FlashPhase.CANCELED
          );
          this.#afterClose = {
            phase: resetTerminal,
            retry: FlashRetry.NONE,
            error: null,
          };
          this.#transition(FlashPhase.CLOSE_OUTCOME_UNCERTAIN, { retry: FlashRetry.CLOSE, error });
          throw error;
        }
        const terminalPhase = this.#afterResetPhase ?? (
          this.#writeMayHaveStarted
            ? FlashPhase.READY_FOR_COMMISSIONING
            : FlashPhase.CANCELED
        );
        this.#afterResetPhase = null;
        if (terminalPhase === FlashPhase.READY_FOR_COMMISSIONING) {
          this.#recoveryRequired = false;
          this.#recoverySessionReady = false;
        }
        this.#transition(terminalPhase);
        return { port: this.#port, snapshot: this.snapshot };
      }
      fail("invalid-state", "no retry is available", { phase: this.#phase });
    });
  }
}
