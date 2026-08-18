import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BrowserFlashController,
  FlashPhase,
  FlashRetry,
  FlashWorkflowError,
  md5Hex,
  prepareFirmwarePackage,
  validateFirmwareManifest,
} from "../../portal/js/flashing.js";
import { createEsptoolJsAdapter } from "../../portal/js/esptool-adapter.js";

const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);

const PARTITIONS = [
  { name: "nvs", type: "data", subtype: "nvs", offset: 0x9000, size: 0x5000, flags: 0 },
  { name: "otadata", type: "data", subtype: "ota", offset: 0xe000, size: 0x2000, flags: 0 },
  { name: "app0", type: "app", subtype: "ota_0", offset: 0x10000, size: 0x140000, flags: 0 },
  { name: "app1", type: "app", subtype: "ota_1", offset: 0x150000, size: 0x140000, flags: 0 },
  { name: "spiffs", type: "data", subtype: "spiffs", offset: 0x290000, size: 0x160000, flags: 0 },
  { name: "coredump", type: "data", subtype: "coredump", offset: 0x3f0000, size: 0x10000, flags: 0 },
];

function bytes(value) {
  return new TextEncoder().encode(value);
}

function nodeSha256(value) {
  return Promise.resolve(createHash("sha256").update(value).digest("hex"));
}

function partitionBinary() {
  const result = new Uint8Array(0xc00).fill(0xff);
  const typeValues = { app: 0, data: 1 };
  const subtypeValues = { nvs: 2, ota: 0, ota_0: 0x10, ota_1: 0x11, spiffs: 0x82, coredump: 3 };
  PARTITIONS.forEach((partition, index) => {
    const offset = index * 32;
    const view = new DataView(result.buffer, offset, 32);
    result[offset] = 0xaa;
    result[offset + 1] = 0x50;
    result[offset + 2] = typeValues[partition.type];
    result[offset + 3] = subtypeValues[partition.subtype];
    view.setUint32(4, partition.offset, true);
    view.setUint32(8, partition.size, true);
    result.set(bytes(partition.name), offset + 12);
    result[offset + 12 + partition.name.length] = 0;
    view.setUint32(28, partition.flags, true);
  });
  const checksumOffset = PARTITIONS.length * 32;
  result[checksumOffset] = 0xeb;
  result[checksumOffset + 1] = 0xeb;
  result.fill(0xff, checksumOffset + 2, checksumOffset + 16);
  const digest = Buffer.from(md5Hex(result.subarray(0, checksumOffset)), "hex");
  result.set(digest, checksumOffset + 16);
  return result;
}

async function fixture(sourceCommit = "0123456789abcdef0123456789abcdef01234567") {
  const contents = {
    "./bootloader.bin": bytes("bootloader"),
    "./partitions.bin": partitionBinary(),
    "./ota_data_initial.bin": new Uint8Array(0x2000),
    "./firmware.bin": bytes("application"),
  };
  const definitions = [
    ["bootloader", "./bootloader.bin", 0],
    ["partition_table", "./partitions.bin", 0x8000],
    ["ota_data", "./ota_data_initial.bin", 0xe000],
    ["application", "./firmware.bin", 0x10000],
  ];
  const files = [];
  for (const [role, path, offset] of definitions) {
    files.push({ role, path, offset, size: contents[path].length, sha256: await nodeSha256(contents[path]) });
  }
  return {
    contents,
    manifest: {
      schema_version: 1,
      product: "sauna_logger",
      release: { version: "0.3.0-dev", source_commit: sourceCommit },
      target: {
        chip: "ESP32-C3",
        board: "seeed_xiao_esp32c3",
        flash_mode: "dio",
        flash_frequency: "80m",
        flash_size: 4 * 1024 * 1024,
        partition_layout: "sauna_ota_v1",
      },
      partitions: PARTITIONS.map((partition) => ({ ...partition })),
      files,
    },
  };
}

async function prepareOptions(contents, counters = {}) {
  return {
    manifestUrl: "https://example.test/generated/firmware/manifest.json",
    digest: nodeSha256,
    loadFile: async (url, file) => {
      counters.loads = (counters.loads ?? 0) + 1;
      return contents[file.path];
    },
  };
}

test("MD5 implementation matches standard vectors", () => {
  const vectors = new Map([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
  ]);
  for (const [input, expected] of vectors) assert.equal(md5Hex(bytes(input)), expected);
});

test("manifest accepts labelled local builds but rejects ambiguous commits", async () => {
  for (const commit of ["0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567-dirty", "unknown"]) {
    validateFirmwareManifest((await fixture(commit)).manifest);
  }
  const { manifest } = await fixture("unknown");
  manifest.release.source_commit = "main";
  assert.throws(() => validateFirmwareManifest(manifest), /source commit/);
});

test("metadata and preservation policy fail before any image load", async () => {
  const { manifest, contents } = await fixture();
  const counters = {};
  manifest.files[3].offset = 0x150000;
  await assert.rejects(
    prepareFirmwarePackage(manifest, await prepareOptions(contents, counters)),
    (error) => error instanceof FlashWorkflowError && error.code === "manifest-files-invalid",
  );
  assert.equal(counters.loads ?? 0, 0);
});

test("manifest rejects every target, layout, path, and write-range deviation", async () => {
  const { manifest } = await fixture();
  const cases = [
    ["schema", (value) => { value.schema_version = 2; }],
    ["product", (value) => { value.product = "another_product"; }],
    ["chip", (value) => { value.target.chip = "ESP32-S3"; }],
    ["board", (value) => { value.target.board = "generic_esp32c3"; }],
    ["flash mode", (value) => { value.target.flash_mode = "qio"; }],
    ["flash frequency", (value) => { value.target.flash_frequency = "40m"; }],
    ["flash size", (value) => { value.target.flash_size = 8 * 1024 * 1024; }],
    ["layout id", (value) => { value.target.partition_layout = "other"; }],
    ["NVS range", (value) => { value.partitions[0].offset += 0x1000; }],
    ["extra partition", (value) => { value.partitions.push({ ...value.partitions[0] }); }],
    ["role", (value) => { value.files[2].role = "nvs"; }],
    ["protected app1 offset", (value) => { value.files[3].offset = 0x150000; }],
    ["oversized bootloader", (value) => { value.files[0].size = 0x8001; }],
    ["wrong partition image size", (value) => { value.files[1].size = 0xbff; }],
    ["truncated OTA data", (value) => { value.files[2].size = 0x1fff; }],
    ["oversized OTA data", (value) => { value.files[2].size = 0x2001; }],
    ["oversized application", (value) => { value.files[3].size = 0x140001; }],
    ["path traversal", (value) => { value.files[0].path = "../bootloader.bin"; }],
    ["encoded path", (value) => { value.files[0].path = "./%2e%2e/bootloader.bin"; }],
    ["duplicate path", (value) => { value.files[1].path = value.files[0].path; }],
    ["invalid digest", (value) => { value.files[0].sha256 = "0".repeat(63); }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(
      () => validateFirmwareManifest(candidate),
      FlashWorkflowError,
      name,
    );
  }
});

test("a SHA-256 failure cannot request a serial port or call the adapter", async () => {
  const { manifest, contents } = await fixture();
  manifest.files[0].sha256 = "0".repeat(64);
  const adapter = fakeAdapter();
  let requests = 0;
  const controller = new BrowserFlashController({
    adapter,
    requestPort: async () => { requests += 1; return {}; },
  });
  await assert.rejects(
    controller.prepare(manifest, await prepareOptions(contents)),
    (error) => error.code === "image-hash-mismatch",
  );
  assert.equal(requests, 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal(controller.snapshot.writeMayHaveStarted, false);
  assert.equal(controller.snapshot.unsafeToUnload, false);
});

test("package validates every size, SHA-256, and the binary partition table", async () => {
  const { manifest, contents } = await fixture();
  const prepared = await prepareFirmwarePackage(manifest, await prepareOptions(contents));
  assert.equal(prepared.files.length, 4);
  assert.match(prepared.packageSha256, /^[0-9a-f]{64}$/);

  const corrupt = { ...contents, "./partitions.bin": new Uint8Array(contents["./partitions.bin"]) };
  corrupt["./partitions.bin"][8] ^= 1;
  const corruptManifest = structuredClone(manifest);
  corruptManifest.files[1].sha256 = await nodeSha256(corrupt["./partitions.bin"]);
  await assert.rejects(
    prepareFirmwarePackage(corruptManifest, await prepareOptions(corrupt)),
    (error) => error.code === "partition-binary-invalid",
  );
});

function fakeAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async connect(port) {
      calls.push(["connect", port]);
      return { chip: "ESP32-C3", flashSize: "4MB", deviceIdHash: DEVICE_A };
    },
    async write(images, { onProgress } = {}) {
      calls.push(["write", images]);
      images.forEach((image, index) => onProgress?.(index, image.data.length, image.data.length));
    },
    async reset() { calls.push(["reset"]); },
    async close() { calls.push(["close"]); },
    ...overrides,
  };
}

async function preparedController(adapter, onDiagnostic = null) {
  const { manifest, contents } = await fixture();
  let requests = 0;
  const port = { name: "port" };
  const controller = new BrowserFlashController({
    adapter,
    requestPort: async () => { requests += 1; return port; },
    onDiagnostic,
  });
  await controller.prepare(manifest, await prepareOptions(contents));
  return { controller, port, requests: () => requests };
}

test("controller validates before requesting a port and closes before commissioning", async () => {
  const adapter = fakeAdapter();
  const { controller, port, requests } = await preparedController(adapter);
  assert.equal(requests(), 0);
  assert.equal(controller.snapshot.phase, FlashPhase.READY_TO_CONNECT);
  await controller.connect();
  assert.equal(requests(), 1);
  assert.equal(controller.snapshot.canCancel, true);
  assert.equal(controller.snapshot.unsafeToUnload, true);
  assert.equal(controller.snapshot.deviceIdHash, DEVICE_A);
  const progress = [];
  const result = await controller.flash({ onProgress: (entry) => progress.push(entry) });
  assert.equal(result.port, port);
  assert.equal(result.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
  assert.equal(result.snapshot.unsafeToUnload, false);
  assert.deepEqual(adapter.calls.map(([name]) => name), ["connect", "write", "reset", "close"]);
  assert.equal(progress.at(-1).fileIndex, 4);
  assert.equal(progress.at(-1).overallWritten, progress.at(-1).overallTotal);
});

test("pre-write cancel hard-resets and closes, and cancel is forbidden after write starts", async () => {
  const adapter = fakeAdapter();
  const { controller } = await preparedController(adapter);
  await controller.connect();
  await controller.disconnect();
  assert.equal(controller.snapshot.phase, FlashPhase.CANCELED);
  assert.deepEqual(adapter.calls.map(([name]) => name), ["connect", "reset", "close"]);

  const writeAdapter = fakeAdapter({ async write() { throw new Error("lost"); } });
  const second = (await preparedController(writeAdapter)).controller;
  await second.connect();
  await assert.rejects(second.flash(), (error) => error.code === "flash-write-uncertain");
  assert.equal(second.snapshot.retry, FlashRetry.REFLASH_SAME_PACKAGE);
  assert.equal(second.snapshot.writeMayHaveStarted, true);
  await assert.rejects(second.cancel(), (error) => error.code === "invalid-state");
});

test("wrong chip is reset and closed without any write", async () => {
  const adapter = fakeAdapter({
    async connect(port) { this.calls.push(["connect", port]); return { chip: "ESP32-S3" }; },
  });
  const { controller } = await preparedController(adapter);
  await assert.rejects(controller.connect(), (error) => error.code === "chip-mismatch");
  assert.deepEqual(adapter.calls.map(([name]) => name), ["connect", "reset", "close"]);
  assert.equal(controller.snapshot.retry, FlashRetry.CONNECT);
});

test("diagnostic callback failures cannot interrupt a verified write", async () => {
  const adapter = fakeAdapter();
  const { controller } = await preparedController(adapter, () => { throw new Error("UI failed"); });
  await controller.connect();
  await controller.flash({ onProgress: () => { throw new Error("progress UI failed"); } });
  assert.equal(controller.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
});

test("uncertain write recovery reselects a newly enumerated port and keeps the same package", async () => {
  const firstPort = { name: "before-power-loss" };
  const secondPort = { name: "after-reenumeration" };
  const requested = [firstPort, secondPort];
  let writes = 0;
  const adapter = fakeAdapter({
    async write(images, { onProgress } = {}) {
      this.calls.push(["write", images]);
      writes += 1;
      if (writes === 1) throw new Error("USB power lost");
      images.forEach((image, index) => onProgress?.(index, image.data.length, image.data.length));
    },
  });
  const { manifest, contents } = await fixture();
  let requestCount = 0;
  const controller = new BrowserFlashController({
    adapter,
    requestPort: async () => requested[requestCount++],
  });
  const prepared = await controller.prepare(manifest, await prepareOptions(contents));
  await controller.connect();
  await assert.rejects(controller.flash(), (error) => error.code === "flash-write-uncertain");
  assert.equal(controller.snapshot.retry, FlashRetry.REFLASH_SAME_PACKAGE);
  await controller.retry();
  assert.equal(requestCount, 2);
  assert.deepEqual(
    adapter.calls.filter(([name]) => name === "connect").map(([, port]) => port),
    [firstPort, secondPort],
  );
  assert.equal(controller.snapshot.prepared.packageSha256, prepared.packageSha256);
  assert.equal(controller.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
});

test("uncertain in-memory recovery cannot move to a different ESP32-C3", async () => {
  let connects = 0;
  let writes = 0;
  const adapter = fakeAdapter({
    async connect(port) {
      this.calls.push(["connect", port]);
      connects += 1;
      return {
        chip: "ESP32-C3",
        flashSize: "4MB",
        deviceIdHash: connects === 1 ? DEVICE_A : DEVICE_B,
      };
    },
    async write(images) {
      this.calls.push(["write", images]);
      writes += 1;
      throw new Error("write interrupted");
    },
  });
  const { controller } = await preparedController(adapter);
  await controller.connect();
  await assert.rejects(
    controller.flash(),
    (error) => error.code === "flash-write-uncertain",
  );
  await assert.rejects(
    controller.retry(),
    (error) => error.code === "device-mismatch",
  );
  assert.equal(writes, 1);
  assert.equal(controller.snapshot.deviceIdHash, DEVICE_A);
  assert.equal(controller.snapshot.phase, FlashPhase.WRITE_OUTCOME_UNCERTAIN);
  assert.equal(controller.snapshot.retry, FlashRetry.REFLASH_SAME_PACKAGE);
});

test("persisted uncertain write remains mandatory after controller reconstruction", async () => {
  const adapter = fakeAdapter();
  const { controller, requests } = await preparedController(adapter);
  const packageSha256 = controller.snapshot.prepared.packageSha256;
  const marked = controller.markRecoveryRequired(packageSha256, DEVICE_A);
  assert.equal(marked.writeMayHaveStarted, true);
  assert.equal(marked.unsafeToUnload, true);
  await controller.connect();
  assert.equal(controller.snapshot.phase, FlashPhase.WRITE_OUTCOME_UNCERTAIN);
  assert.equal(controller.snapshot.retry, FlashRetry.REFLASH_SAME_PACKAGE);
  assert.equal(controller.snapshot.canCancel, false);
  assert.equal(controller.snapshot.deviceIdHash, DEVICE_A);
  await assert.rejects(controller.cancel(), (error) => error.code === "invalid-state");
  await controller.retry();
  assert.equal(requests(), 1, "the freshly selected recovery session is reused");
  assert.equal(controller.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
  assert.equal(controller.snapshot.unsafeToUnload, false);
});

test("persisted recovery rejects a different physical ESP32-C3 before reflash", async () => {
  const adapter = fakeAdapter({
    async connect(port) {
      this.calls.push(["connect", port]);
      return { chip: "ESP32-C3", flashSize: "4MB", deviceIdHash: DEVICE_B };
    },
  });
  const { controller } = await preparedController(adapter);
  controller.markRecoveryRequired(
    controller.snapshot.prepared.packageSha256,
    DEVICE_A,
  );
  await assert.rejects(
    controller.connect(),
    (error) => error.code === "device-mismatch",
  );
  assert.equal(controller.snapshot.writeMayHaveStarted, true);
  assert.equal(controller.snapshot.unsafeToUnload, true);
  assert.equal(controller.snapshot.deviceIdHash, null);
  assert.equal(controller.snapshot.retry, FlashRetry.CONNECT);
  assert.equal(adapter.calls.some(([name]) => name === "write"), false);
  assert.deepEqual(
    adapter.calls.map(([name]) => name),
    ["connect", "reset", "close"],
  );
});

test("persisted recovery cannot be attached to a different package", async () => {
  const adapter = fakeAdapter();
  const { controller } = await preparedController(adapter);
  assert.throws(
    () => controller.markRecoveryRequired("f".repeat(64), DEVICE_A),
    (error) => error.code === "recovery-package-mismatch",
  );
  assert.throws(
    () => controller.markRecoveryRequired(
      controller.snapshot.prepared.packageSha256,
      "not-a-device-hash",
    ),
    (error) => error.code === "recovery-device-mismatch",
  );
  assert.equal(controller.snapshot.phase, FlashPhase.READY_TO_CONNECT);
});

test("reset uncertainty while rejecting a board returns to selection, never to completion", async () => {
  let connects = 0;
  let resets = 0;
  const adapter = fakeAdapter({
    async connect(port) {
      this.calls.push(["connect", port]);
      connects += 1;
      return {
        chip: connects === 1 ? "ESP32-S3" : "ESP32-C3",
        flashSize: "4MB",
        deviceIdHash: DEVICE_A,
      };
    },
    async reset() {
      this.calls.push(["reset"]);
      resets += 1;
      if (resets === 1) throw new Error("reset line unavailable");
    },
  });
  const { controller } = await preparedController(adapter);
  await assert.rejects(controller.connect(), (error) => error.code === "reset-outcome-uncertain");
  assert.equal(controller.snapshot.phase, FlashPhase.RESET_OUTCOME_UNCERTAIN);
  await controller.retry();
  assert.equal(controller.snapshot.phase, FlashPhase.READY_TO_CONNECT);
  assert.equal(controller.snapshot.writeMayHaveStarted, false);
});

test("failed close after an uncertain write cannot skip same-package reflash", async () => {
  let writes = 0;
  let closes = 0;
  const adapter = fakeAdapter({
    async write(images, { onProgress } = {}) {
      this.calls.push(["write", images]);
      writes += 1;
      if (writes === 1) throw new Error("write interrupted");
      images.forEach((image, index) => onProgress?.(index, image.data.length, image.data.length));
    },
    async close() {
      this.calls.push(["close"]);
      closes += 1;
      if (closes === 1) throw new Error("port still locked");
    },
  });
  const { controller, requests } = await preparedController(adapter);
  await controller.connect();
  await assert.rejects(controller.flash(), (error) => error.code === "close-outcome-uncertain");
  assert.equal(controller.snapshot.retry, FlashRetry.CLOSE);
  await controller.retry();
  assert.equal(controller.snapshot.phase, FlashPhase.WRITE_OUTCOME_UNCERTAIN);
  assert.equal(controller.snapshot.retry, FlashRetry.REFLASH_SAME_PACKAGE);
  assert.equal(controller.snapshot.unsafeToUnload, true);
  await controller.retry();
  assert.equal(requests(), 2);
  assert.equal(writes, 2);
  assert.equal(controller.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
});

test("cancel reset and close uncertainties both resolve before cancellation", async () => {
  let resets = 0;
  let closes = 0;
  const adapter = fakeAdapter({
    async reset() {
      this.calls.push(["reset"]);
      resets += 1;
      if (resets === 1) throw new Error("reset uncertain");
    },
    async close() {
      this.calls.push(["close"]);
      closes += 1;
      if (closes === 1) throw new Error("close uncertain");
    },
  });
  const { controller } = await preparedController(adapter);
  await controller.connect();
  await assert.rejects(controller.cancel(), (error) => error.code === "close-outcome-uncertain");
  await controller.retry();
  assert.equal(controller.snapshot.phase, FlashPhase.RESET_OUTCOME_UNCERTAIN);
  await controller.retry();
  assert.equal(controller.snapshot.phase, FlashPhase.CANCELED);
  assert.equal(controller.snapshot.writeMayHaveStarted, false);
});

test("a repeated reset failure closes before the next chooser gesture", async () => {
  const log = [];
  let resetCount = 0;
  let closeCount = 0;
  const adapter = {
    async connect(port) {
      log.push(["connect", port]);
      return { chip: "ESP32-C3", flashSize: "4MB", deviceIdHash: DEVICE_A };
    },
    async write(images, { onProgress } = {}) {
      log.push(["write"]);
      images.forEach((image, index) =>
        onProgress?.(index, image.data.length, image.data.length)
      );
    },
    async reset() {
      resetCount += 1;
      log.push(["reset", resetCount]);
      if (resetCount <= 2) throw new Error(`reset ${resetCount} failed`);
    },
    async close() {
      closeCount += 1;
      log.push(["close", closeCount]);
      if (closeCount === 2) throw new Error("retry transport stayed locked");
    },
  };
  const ports = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let requestCount = 0;
  const { manifest, contents } = await fixture();
  const controller = new BrowserFlashController({
    adapter,
    requestPort: async () => {
      log.push(["request", requestCount + 1]);
      return ports[requestCount++];
    },
  });
  await controller.prepare(manifest, await prepareOptions(contents));
  await controller.connect();
  await assert.rejects(
    controller.flash(),
    (error) => error.code === "reset-outcome-uncertain",
  );
  await assert.rejects(
    controller.retry(),
    (error) => error.code === "close-outcome-uncertain",
  );
  assert.equal(controller.snapshot.phase, FlashPhase.CLOSE_OUTCOME_UNCERTAIN);
  assert.equal(controller.snapshot.retry, FlashRetry.CLOSE);
  await controller.retry();
  assert.equal(controller.snapshot.phase, FlashPhase.RESET_OUTCOME_UNCERTAIN);
  assert.deepEqual(log.at(-1), ["close", 3], "close uncertainty must resolve explicitly");

  const beforeRetry = log.length;
  const finalRetry = controller.retry();
  assert.deepEqual(
    log[beforeRetry],
    ["request", 3],
    "the next recovery click must reach requestPort before any awaited cleanup",
  );
  await finalRetry;
  assert.equal(controller.snapshot.phase, FlashPhase.READY_FOR_COMMISSIONING);
  assert.equal(requestCount, 3);
});

test("esptool adapter pins safe write settings and requires device MD5 verification", async () => {
  const instances = {};
  class Transport {
    constructor(port, tracing) { instances.port = port; instances.tracing = tracing; }
    async disconnect() { instances.disconnected = true; }
  }
  class ESPLoader {
    constructor(options) {
      instances.options = options;
      this.DETECTED_FLASH_SIZES = { 0x16: "4MB" };
      this.chip = {
        CHIP_NAME: "ESP32-C3",
        async readMac(loader) {
          instances.order.push("readMac");
          instances.macLoader = loader;
          return "AA:BB:CC:DD:EE:FF";
        },
      };
      instances.loader = this;
      instances.order = [];
    }
    async main(resetMode) {
      instances.order.push("main");
      instances.main = resetMode;
      return "ESP32-C3";
    }
    async readFlashId() {
      instances.order.push("readFlashId");
      return 0x1640ef;
    }
    async writeFlash(options) { instances.write = options; options.reportProgress?.(0, 1, 1); }
    async after(mode) { instances.after = mode; }
  }
  const diagnostics = [];
  const adapter = createEsptoolJsAdapter(
    { Transport, ESPLoader },
    {
      eraseAll: true,
      onDiagnostic: (entry) => { diagnostics.push(entry); throw new Error("ignored"); },
    },
  );
  const port = {};
  const connected = await adapter.connect(port);
  const expectedDeviceIdHash = await nodeSha256(
    bytes("sauna_logger:web-flash-device-id:v1\0aa:bb:cc:dd:ee:ff"),
  );
  assert.deepEqual(connected, {
    chip: "ESP32-C3",
    description: "ESP32-C3",
    flashSize: "4MB",
    deviceIdHash: expectedDeviceIdHash,
  });
  assert.deepEqual(instances.order, ["main", "readFlashId", "readMac"]);
  assert.equal(instances.macLoader, instances.loader);
  assert.doesNotMatch(JSON.stringify(connected), /AA:BB|aa:bb/);
  instances.options.terminal.writeLine("Writing at 0x0");
  const images = [
    ["bootloader", 0], ["partition_table", 0x8000], ["ota_data", 0xe000], ["application", 0x10000],
  ].map(([role, address]) => ({
    role,
    address,
    data: role === "partition_table"
      ? new Uint8Array(0xc00)
      : role === "ota_data"
        ? new Uint8Array(0x2000)
        : bytes(role),
  }));
  const unsafeImages = images.map((image) => ({ ...image }));
  unsafeImages[0] = {
    ...unsafeImages[0],
    data: new Uint8Array(0x8001),
  };
  await assert.rejects(
    adapter.write(unsafeImages),
    /preserved flash range/,
  );
  const truncatedOtaImages = images.map((image) => ({ ...image }));
  truncatedOtaImages[2] = {
    ...truncatedOtaImages[2],
    data: new Uint8Array(0x1fff),
  };
  await assert.rejects(
    adapter.write(truncatedOtaImages),
    /unsafe size/,
  );
  await adapter.write(images, { onProgress() {} });
  assert.equal(instances.write.eraseAll, false);
  assert.equal(instances.write.flashMode, "dio");
  assert.equal(instances.write.flashFreq, "80m");
  assert.equal(instances.write.flashSize, "4MB");
  assert.equal(instances.write.calculateMD5Hash(bytes("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(typeof instances.write.calculateMD5Hash, "function");
  await adapter.reset();
  await adapter.close();
  assert.equal(instances.after, "hard_reset");
  assert.equal(instances.disconnected, true);
  assert.ok(diagnostics.some((entry) =>
    entry.source === "esptool" &&
    entry.type === "message" &&
    entry.message === "Writing at 0x0"
  ));
  assert.doesNotMatch(JSON.stringify(diagnostics), /AA:BB|aa:bb/);
});

test("esptool adapter rejects 2MB and unknown JEDEC capacities before identity or write", async () => {
  for (const [name, capacityCode, sizes] of [
    ["2MB", 0x15, { 0x15: "2MB" }],
    ["unknown", 0x7f, { 0x16: "4MB" }],
  ]) {
    const calls = { mac: 0, write: 0, reset: 0, close: 0 };
    class Transport {
      async disconnect() { calls.close += 1; }
    }
    class ESPLoader {
      constructor() {
        this.DETECTED_FLASH_SIZES = sizes;
        this.chip = {
          CHIP_NAME: "ESP32-C3",
          async readMac() { calls.mac += 1; return "00:11:22:33:44:55"; },
        };
      }
      async main() { return "ESP32-C3"; }
      async readFlashId() { return (capacityCode << 16) | 0x40ef; }
      async writeFlash() { calls.write += 1; }
      async after() { calls.reset += 1; }
    }
    const adapter = createEsptoolJsAdapter({ Transport, ESPLoader });
    await assert.rejects(
      adapter.connect({}),
      (error) =>
        error.code === "target-flash-size-mismatch" &&
        (name === "unknown" ? /unknown/.test(error.message) : /2MB/.test(error.message)),
      name,
    );
    assert.equal(calls.mac, 0, `${name} capacity must fail before reading identity`);
    await assert.rejects(
      adapter.write([]),
      /target validation is incomplete/,
      `${name} rejection must leave writes locked`,
    );
    assert.equal(calls.write, 0, `${name} capacity must fail before writing`);
    await adapter.reset();
    await adapter.close();
    assert.equal(calls.reset, 1);
    assert.equal(calls.close, 1);
  }
});
