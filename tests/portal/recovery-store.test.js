import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { md5Hex, prepareFirmwarePackage } from "../../portal/js/flashing.js";
import {
  FirmwareRecoveryStore,
  RECOVERY_LIFECYCLE_LOCK,
  RECOVERY_PACKAGE_CACHE_PREFIX,
  RECOVERY_STORAGE_KEY,
  RecoveryPhase,
  restoreOrRepairRecoveryPackage,
} from "../../portal/js/recovery-store.js";

const PARTITIONS = [
  { name: "nvs", type: "data", subtype: "nvs", offset: 0x9000, size: 0x5000, flags: 0 },
  { name: "otadata", type: "data", subtype: "ota", offset: 0xe000, size: 0x2000, flags: 0 },
  { name: "app0", type: "app", subtype: "ota_0", offset: 0x10000, size: 0x140000, flags: 0 },
  { name: "app1", type: "app", subtype: "ota_1", offset: 0x150000, size: 0x140000, flags: 0 },
  { name: "spiffs", type: "data", subtype: "spiffs", offset: 0x290000, size: 0x160000, flags: 0 },
  { name: "coredump", type: "data", subtype: "coredump", offset: 0x3f0000, size: 0x10000, flags: 0 },
];

const bytes = (value) => new TextEncoder().encode(value);
const digest = (value) =>
  Promise.resolve(createHash("sha256").update(value).digest("hex"));

function partitionBinary() {
  const result = new Uint8Array(0xc00).fill(0xff);
  const types = { app: 0, data: 1 };
  const subtypes = {
    nvs: 2,
    ota: 0,
    ota_0: 0x10,
    ota_1: 0x11,
    spiffs: 0x82,
    coredump: 3,
  };
  PARTITIONS.forEach((partition, index) => {
    const offset = index * 32;
    const view = new DataView(result.buffer, offset, 32);
    result[offset] = 0xaa;
    result[offset + 1] = 0x50;
    result[offset + 2] = types[partition.type];
    result[offset + 3] = subtypes[partition.subtype];
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
  result.set(
    Buffer.from(md5Hex(result.subarray(0, checksumOffset)), "hex"),
    checksumOffset + 16,
  );
  return result;
}

async function preparedFixture(version = "0.3.0-dev") {
  const contents = {
    "./bootloader.bin": bytes(`bootloader-${version}`),
    "./partitions.bin": partitionBinary(),
    "./ota_data_initial.bin": new Uint8Array(0x2000),
    "./firmware.bin": bytes(`application-${version}`),
  };
  const declarations = [
    ["bootloader", "./bootloader.bin", 0],
    ["partition_table", "./partitions.bin", 0x8000],
    ["ota_data", "./ota_data_initial.bin", 0xe000],
    ["application", "./firmware.bin", 0x10000],
  ];
  const files = [];
  for (const [role, path, offset] of declarations) {
    files.push({
      role,
      path,
      offset,
      size: contents[path].length,
      sha256: await digest(contents[path]),
    });
  }
  const manifest = {
    schema_version: 1,
    product: "sauna_logger",
    release: {
      version,
      source_commit: version === "0.3.0-dev"
        ? "0123456789abcdef0123456789abcdef01234567"
        : "89abcdef0123456789abcdef0123456789abcdef",
    },
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
  };
  return prepareFirmwarePackage(manifest, {
    manifestUrl: "https://example.test/generated/firmware/manifest.json",
    digest,
    loadFile: async (_url, file) => contents[file.path],
  });
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failWrites = false;
    this.failRemoves = false;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error("storage denied");
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.failRemoves) throw new Error("storage denied");
    this.values.delete(key);
  }
}

const requestKey = (request) =>
  typeof request === "string" ? request : request.url;

class MemoryCache {
  constructor() {
    this.responses = new Map();
  }

  async put(request, response) {
    this.responses.set(requestKey(request), response.clone());
  }

  async match(request) {
    return this.responses.get(requestKey(request))?.clone();
  }
}

class MemoryCacheStorage {
  constructor() {
    this.caches = new Map();
  }

  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache());
    return this.caches.get(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }
}

class MemoryLockManager {
  constructor() {
    this.held = new Set();
    this.requests = [];
  }

  async request(name, options, callback) {
    this.requests.push({ name, options: { ...options } });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback(Object.freeze({ name, mode: options.mode }));
    } finally {
      this.held.delete(name);
    }
  }
}

function expectation(prepared) {
  return {
    product: prepared.manifest.product,
    firmware: prepared.manifest.release.version,
    commit: prepared.manifest.release.source_commit,
    partition: prepared.manifest.target.partition_layout,
    ota: "app0",
  };
}

function makeStore({
  storage,
  cacheStorage,
  now = 0,
  lockManager = new MemoryLockManager(),
}) {
  return new FirmwareRecoveryStore({
    storage,
    cacheStorage,
    baseUrl: "https://example.test/portal/",
    digest,
    now: () => new Date(now),
    lockManager,
  });
}

test("content-addressed cache restores and revalidates the exact four images", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const store = makeStore({ storage, cacheStorage });
  const prepared = await preparedFixture();
  const originalApplication = new Uint8Array(prepared.files[3].data);

  const persisted = await store.persistPreparedPackage(prepared);
  assert.equal(persisted.packageSha256, prepared.packageSha256);
  assert.equal(persisted.files.length, 4);
  prepared.files[3].data.fill(0);

  const restored = await store.restorePreparedPackage(prepared.packageSha256);
  assert.deepEqual(restored.files[3].data, originalApplication);
  const names = await cacheStorage.keys();
  assert.deepEqual(names, [
    `${RECOVERY_PACKAGE_CACHE_PREFIX}${prepared.packageSha256}`,
  ]);
  assert.ok(!names[0].startsWith("sauna-commissioning-"));

  const cache = await cacheStorage.open(names[0]);
  await cache.put(
    `https://example.test/__sauna_firmware_recovery__/v1/${prepared.packageSha256}/3-application.bin`,
    new Response(bytes("tampered")),
  );
  await assert.rejects(
    store.restorePreparedPackage(prepared.packageSha256),
    (error) => error.code === "image-size-mismatch" || error.code === "image-hash-mismatch",
  );
});

test("a write is blocked unless its marker round-trips through localStorage", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const store = makeStore({ storage, cacheStorage });
  const prepared = await preparedFixture();
  await store.persistPreparedPackage(prepared);
  await store.acquireLifecycleIfAvailable();
  storage.failWrites = true;
  let writeCalled = false;

  await assert.rejects(
    (async () => {
      await store.beginWrite({
        packageSha256: prepared.packageSha256,
        deviceIdHash: "a".repeat(64),
        expectation: expectation(prepared),
      });
      writeCalled = true;
    })(),
    (error) => error.code === "recovery-storage-unavailable",
  );
  assert.equal(writeCalled, false);
  assert.equal(storage.getItem(RECOVERY_STORAGE_KEY), null);
});

test("reload preserves board, package, and exact post-flash verification target", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const prepared = await preparedFixture();
  const lockManager = new MemoryLockManager();
  const first = makeStore({ storage, cacheStorage, now: 1_000, lockManager });
  await first.persistPreparedPackage(prepared);
  await first.acquireLifecycleIfAvailable();
  const expected = expectation(prepared);
  const deviceIdHash = "b".repeat(64);

  await assert.rejects(
    first.beginWrite({
      packageSha256: prepared.packageSha256,
      deviceIdHash,
      expectation: { ...expected, firmware: "different" },
    }),
    (error) => error.code === "recovery-package-mismatch",
  );
  assert.equal(first.readMarker(), null);

  const writing = await first.beginWrite({
    packageSha256: prepared.packageSha256,
    deviceIdHash,
    expectation: expected,
  });
  assert.equal(writing.phase, RecoveryPhase.WRITE_REQUIRED);
  assert.equal(first.ownsLifecycle, true);

  await first.releaseLifecycle();
  const afterReload = makeStore({ storage, cacheStorage, now: 2_000, lockManager });
  await afterReload.acquireLifecycleIfAvailable();
  assert.deepEqual(afterReload.readMarker(), writing);
  await assert.rejects(
    afterReload.beginWrite({
      packageSha256: prepared.packageSha256,
      deviceIdHash: "c".repeat(64),
      expectation: expected,
    }),
    (error) => error.code === "recovery-record-conflict",
  );
  assert.deepEqual(afterReload.readMarker(), writing);
  const verifying = afterReload.markVerificationRequired();
  assert.equal(verifying.phase, RecoveryPhase.VERIFICATION_REQUIRED);
  assert.equal(afterReload.ownsLifecycle, true);
  assert.deepEqual(verifying.expectation, expected);
  assert.equal(verifying.deviceIdHash, deviceIdHash);

  await assert.rejects(
    afterReload.completeVerifiedFirmware({
      packageSha256: prepared.packageSha256,
      deviceIdHash,
      expectation: { ...expected, ota: "app1" },
    }),
    (error) => error.code === "recovery-package-mismatch",
  );
  assert.ok(afterReload.readMarker(), "a mismatch must retain mandatory verification");
  assert.equal(afterReload.ownsLifecycle, true);

  storage.failRemoves = true;
  await assert.rejects(
    afterReload.completeVerifiedFirmware({
      packageSha256: prepared.packageSha256,
      deviceIdHash,
      expectation: expected,
    }),
    (error) => error.code === "recovery-storage-unavailable",
  );
  storage.failRemoves = false;
  assert.ok(afterReload.readMarker(), "a failed clear must remain locked");
  assert.equal(afterReload.ownsLifecycle, true);

  const contender = makeStore({ storage, cacheStorage, now: 3_000, lockManager });
  await assert.rejects(
    contender.acquireLifecycleIfAvailable(),
    (error) => error.code === "recovery-lock-held",
  );

  assert.equal(await afterReload.completeVerifiedFirmware({
    packageSha256: prepared.packageSha256,
    deviceIdHash,
    expectation: expected,
  }), true);
  assert.equal(afterReload.readMarker(), null);
  assert.equal(afterReload.ownsLifecycle, false);
  await contender.acquireLifecycleIfAvailable();
  await contender.releaseLifecycle();
  assert.equal(
    (await afterReload.restorePreparedPackage(prepared.packageSha256)).packageSha256,
    prepared.packageSha256,
    "verified packages remain as immutable offline install sources",
  );
});

test("offline selection restores the newest complete validated package", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const older = await preparedFixture("0.3.0-dev");
  const newer = await preparedFixture("0.3.1-dev");
  await makeStore({ storage, cacheStorage, now: 1_000 }).persistPreparedPackage(older);
  const current = makeStore({ storage, cacheStorage, now: 2_000 });
  await current.persistPreparedPackage(newer);

  const restored = await makeStore({
    storage,
    cacheStorage,
    now: 3_000,
  }).restoreLatestPreparedPackage();
  assert.equal(restored.packageSha256, newer.packageSha256);
  assert.equal(restored.manifest.release.version, "0.3.1-dev");
});

test("an origin-wide lifecycle lock fails closed instead of queuing another tab", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const lockManager = new MemoryLockManager();
  const first = makeStore({ storage, cacheStorage, lockManager });
  const second = makeStore({ storage, cacheStorage, lockManager });
  await first.acquireLifecycleIfAvailable();
  assert.equal(first.ownsLifecycle, true);
  await assert.rejects(
    second.acquireLifecycleIfAvailable(),
    (error) => error.code === "recovery-lock-held",
  );
  assert.deepEqual(lockManager.requests[0], {
    name: RECOVERY_LIFECYCLE_LOCK,
    options: { mode: "exclusive", ifAvailable: true },
  });

  const prepared = await preparedFixture();
  await first.persistPreparedPackage(prepared);
  await assert.rejects(
    second.beginWrite({
      packageSha256: prepared.packageSha256,
      deviceIdHash: "d".repeat(64),
      expectation: expectation(prepared),
    }),
    (error) => error.code === "recovery-lock-required",
  );
  assert.equal(second.readMarker(), null);

  await first.releaseLifecycle();
  await second.acquireLifecycleIfAvailable();
  assert.equal(second.ownsLifecycle, true);
  await second.releaseLifecycle();

  const unsupported = makeStore({ storage, cacheStorage, lockManager: null });
  await assert.rejects(
    unsupported.acquireLifecycleIfAvailable(),
    (error) => error.code === "recovery-lock-unavailable",
  );
});

test("missing recovery cache is repaired only by the exact online package", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const lockManager = new MemoryLockManager();
  const prepared = await preparedFixture();
  const first = makeStore({ storage, cacheStorage, lockManager });
  await first.persistPreparedPackage(prepared);
  await first.acquireLifecycleIfAvailable();
  const marker = await first.beginWrite({
    packageSha256: prepared.packageSha256,
    deviceIdHash: "e".repeat(64),
    expectation: expectation(prepared),
  });
  await first.releaseLifecycle();
  cacheStorage.caches.delete(
    `${RECOVERY_PACKAGE_CACHE_PREFIX}${prepared.packageSha256}`,
  );

  const recovered = makeStore({ storage, cacheStorage, lockManager });
  await recovered.acquireLifecycleIfAvailable();
  let downloads = 0;
  const restored = await restoreOrRepairRecoveryPackage({
    store: recovered,
    marker,
    downloadPackage: async () => { downloads += 1; return prepared; },
  });
  assert.equal(downloads, 1);
  assert.equal(restored.packageSha256, marker.packageSha256);
  assert.equal(
    (await recovered.restorePreparedPackage(marker.packageSha256)).packageSha256,
    marker.packageSha256,
  );
  await recovered.releaseLifecycle();
});

test("online recovery never caches or accepts a different current release", async () => {
  const storage = new MemoryStorage();
  const cacheStorage = new MemoryCacheStorage();
  const lockManager = new MemoryLockManager();
  const required = await preparedFixture("0.3.0-dev");
  const different = await preparedFixture("0.3.1-dev");
  const first = makeStore({ storage, cacheStorage, lockManager });
  await first.persistPreparedPackage(required);
  await first.acquireLifecycleIfAvailable();
  const marker = await first.beginWrite({
    packageSha256: required.packageSha256,
    deviceIdHash: "f".repeat(64),
    expectation: expectation(required),
  });
  await first.releaseLifecycle();
  cacheStorage.caches.delete(
    `${RECOVERY_PACKAGE_CACHE_PREFIX}${required.packageSha256}`,
  );

  const recovered = makeStore({ storage, cacheStorage, lockManager });
  await recovered.acquireLifecycleIfAvailable();
  await assert.rejects(
    restoreOrRepairRecoveryPackage({
      store: recovered,
      marker,
      downloadPackage: async () => different,
    }),
    (error) => error.code === "recovery-package-mismatch",
  );
  assert.deepEqual(recovered.readMarker(), marker);
  assert.equal(
    cacheStorage.caches.has(
      `${RECOVERY_PACKAGE_CACHE_PREFIX}${different.packageSha256}`,
    ),
    false,
  );
  await recovered.releaseLifecycle();
});
