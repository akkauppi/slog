import { prepareFirmwarePackage, sha256Hex } from "./flashing.js";

export const RECOVERY_STORAGE_KEY =
  "sauna-logger:firmware-install:recovery:v1";
export const RECOVERY_PACKAGE_CACHE_PREFIX =
  "sauna-firmware-recovery-v1-";
export const RECOVERY_LIFECYCLE_LOCK =
  "sauna-logger:firmware-install:lifecycle:v1";

export const RecoveryPhase = Object.freeze({
  WRITE_REQUIRED: "write_required",
  VERIFICATION_REQUIRED: "verification_required",
});

const MARKER_SCHEMA_VERSION = 1;
const PACKAGE_RECORD_SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTATION_KEYS = ["product", "firmware", "commit", "partition", "ota"];
const REPAIRABLE_PACKAGE_ERRORS = new Set([
  "recovery-package-missing",
  "recovery-package-invalid",
  "recovery-package-mismatch",
  "manifest-invalid",
  "manifest-schema-unsupported",
  "manifest-product-mismatch",
  "manifest-version-invalid",
  "manifest-target-mismatch",
  "manifest-partition-layout-mismatch",
  "manifest-files-invalid",
  "image-size-mismatch",
  "image-hash-mismatch",
  "partition-binary-invalid",
]);

export class FirmwareRecoveryStoreError extends Error {
  constructor(code, message, { cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FirmwareRecoveryStoreError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new FirmwareRecoveryStoreError(code, message, options);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, expected, description) {
  if (!isObject(value)) fail("recovery-record-invalid", `${description} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("recovery-record-invalid", `${description} has unexpected or missing fields`);
  }
}

function requireHash(value, description) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("recovery-record-invalid", `${description} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireTimestamp(value, description) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("recovery-record-invalid", `${description} must be an ISO timestamp`);
  }
  return value;
}

export function validateFirmwareExpectation(value) {
  requireExactKeys(value, EXPECTATION_KEYS, "firmware expectation");
  const normalized = {};
  for (const key of EXPECTATION_KEYS) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      fail("recovery-record-invalid", `firmware expectation ${key} must be a non-empty string`);
    }
    normalized[key] = value[key];
  }
  return normalized;
}

export function validateRecoveryMarker(value) {
  requireExactKeys(
    value,
    [
      "schemaVersion",
      "phase",
      "packageSha256",
      "deviceIdHash",
      "expectation",
      "startedAt",
      "updatedAt",
    ],
    "firmware recovery marker",
  );
  if (value.schemaVersion !== MARKER_SCHEMA_VERSION) {
    fail("recovery-record-invalid", "firmware recovery marker schema is unsupported");
  }
  if (!Object.values(RecoveryPhase).includes(value.phase)) {
    fail("recovery-record-invalid", "firmware recovery marker phase is invalid");
  }
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    phase: value.phase,
    packageSha256: requireHash(value.packageSha256, "firmware package identity"),
    deviceIdHash: requireHash(value.deviceIdHash, "device identity"),
    expectation: validateFirmwareExpectation(value.expectation),
    startedAt: requireTimestamp(value.startedAt, "firmware recovery start"),
    updatedAt: requireTimestamp(value.updatedAt, "firmware recovery update"),
  };
}

function expectationMatches(left, right) {
  return EXPECTATION_KEYS.every((key) => left[key] === right[key]);
}

function expectationFromPrepared(prepared) {
  return {
    product: prepared.manifest.product,
    firmware: prepared.manifest.release.version,
    commit: prepared.manifest.release.source_commit,
    partition: prepared.manifest.target.partition_layout,
    ota: "app0",
  };
}

function requireExactMarkerPackage(marker, prepared) {
  if (
    prepared.packageSha256 !== marker.packageSha256 ||
    !expectationMatches(marker.expectation, expectationFromPrepared(prepared))
  ) {
    fail(
      "recovery-package-mismatch",
      "firmware package does not match the mandatory recovery record",
    );
  }
  return prepared;
}

function asTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("recovery-storage-unavailable", "recovery clock returned an invalid time");
  }
  return date.toISOString();
}

function fileLoader(prepared) {
  const files = new Map(prepared.files.map((file) => [file.path, file]));
  return async (_url, requested) => {
    const file = files.get(requested.path);
    if (!file || file.role !== requested.role) {
      fail("recovery-package-invalid", `cached ${requested.role} image is missing`);
    }
    return new Uint8Array(file.data);
  };
}

async function revalidatePrepared(prepared, digest) {
  if (!isObject(prepared) || !Array.isArray(prepared.files)) {
    fail("recovery-package-invalid", "prepared firmware package is incomplete");
  }
  const validated = await prepareFirmwarePackage(prepared.manifest, {
    manifestUrl: prepared.manifestUrl,
    digest,
    loadFile: fileLoader(prepared),
  });
  if (validated.packageSha256 !== prepared.packageSha256) {
    fail("recovery-package-mismatch", "prepared firmware package identity changed");
  }
  return validated;
}

/**
 * Durable, content-addressed firmware recovery state.
 *
 * Package caches deliberately do not use the service worker's
 * `sauna-commissioning-*` prefix. A worker activation may replace its app
 * shell, but it must not delete the only exact bytes that can recover an
 * interrupted write.
 */
export class FirmwareRecoveryStore {
  #ownsLifecycle = false;

  constructor({
    storage = globalThis.localStorage,
    cacheStorage = globalThis.caches,
    baseUrl = globalThis.location?.href,
    digest = sha256Hex,
    now = () => new Date(),
    lockManager = globalThis.navigator?.locks,
  } = {}) {
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function" ||
        typeof storage.removeItem !== "function") {
      fail("recovery-storage-unavailable", "local recovery storage is unavailable");
    }
    if (typeof digest !== "function" || typeof now !== "function") {
      throw new TypeError("digest and now must be functions");
    }
    let parsedBase;
    try {
      parsedBase = new URL(baseUrl);
    } catch (cause) {
      fail("recovery-cache-unavailable", "firmware recovery cache URL is invalid", { cause });
    }
    if (!new Set(["http:", "https:"]).has(parsedBase.protocol)) {
      fail("recovery-cache-unavailable", "firmware recovery requires an HTTP(S) origin");
    }
    this.storage = storage;
    this.cacheStorage = cacheStorage;
    this.origin = parsedBase.origin;
    this.digest = digest;
    this.now = now;
    this.lockManager = lockManager;
    this._releaseLifecycle = null;
    this._lifecycleRequest = null;
    this._lifecycleError = null;
  }

  get ownsLifecycle() {
    return this.#ownsLifecycle;
  }

  async acquireLifecycleIfAvailable() {
    if (this.#ownsLifecycle) return true;
    if (!this.lockManager || typeof this.lockManager.request !== "function") {
      fail(
        "recovery-lock-unavailable",
        "this browser cannot exclusively protect the firmware recovery lifecycle",
      );
    }

    let signalResolve;
    let signalReject;
    let signaled = false;
    const acquired = new Promise((resolve, reject) => {
      signalResolve = resolve;
      signalReject = reject;
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let request;
    try {
      request = this.lockManager.request(
        RECOVERY_LIFECYCLE_LOCK,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          signaled = true;
          if (!lock) {
            signalResolve(false);
            return;
          }
          this.#ownsLifecycle = true;
          this._releaseLifecycle = release;
          signalResolve(true);
          await held;
          this.#ownsLifecycle = false;
          this._releaseLifecycle = null;
        },
      );
    } catch (cause) {
      fail("recovery-lock-unavailable", "firmware recovery lock request failed", { cause });
    }
    this._lifecycleError = null;
    this._lifecycleRequest = Promise.resolve(request).catch((cause) => {
      if (!signaled) signalReject(cause);
      this._lifecycleError = cause;
    });

    let available;
    try {
      available = await acquired;
    } catch (cause) {
      this._lifecycleRequest = null;
      this._lifecycleError = null;
      fail("recovery-lock-unavailable", "firmware recovery lock request failed", { cause });
    }
    if (!available) {
      await this._lifecycleRequest;
      this._lifecycleRequest = null;
      fail(
        "recovery-lock-held",
        "another portal tab owns the firmware recovery lifecycle",
      );
    }
    return true;
  }

  async releaseLifecycle() {
    if (!this.#ownsLifecycle) return false;
    const release = this._releaseLifecycle;
    const request = this._lifecycleRequest;
    release?.();
    try {
      await request;
      if (this._lifecycleError) throw this._lifecycleError;
    } catch (cause) {
      fail("recovery-lock-unavailable", "firmware recovery lock release failed", { cause });
    } finally {
      this._lifecycleRequest = null;
      this._lifecycleError = null;
    }
    return true;
  }

  #requireLifecycle() {
    if (!this.#ownsLifecycle) {
      fail(
        "recovery-lock-required",
        "firmware recovery state cannot change without the exclusive lifecycle lock",
      );
    }
  }

  readMarker() {
    let raw;
    try {
      raw = this.storage.getItem(RECOVERY_STORAGE_KEY);
    } catch (cause) {
      fail("recovery-storage-unavailable", "firmware recovery marker could not be read", { cause });
    }
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      fail("recovery-record-invalid", "firmware recovery marker is damaged", { cause });
    }
    return validateRecoveryMarker(parsed);
  }

  writeMarker(value) {
    this.#requireLifecycle();
    const marker = validateRecoveryMarker(value);
    const serialized = JSON.stringify(marker);
    try {
      this.storage.setItem(RECOVERY_STORAGE_KEY, serialized);
      const roundTrip = this.storage.getItem(RECOVERY_STORAGE_KEY);
      if (roundTrip !== serialized) {
        fail("recovery-storage-unavailable", "firmware recovery marker did not persist exactly");
      }
    } catch (cause) {
      if (cause instanceof FirmwareRecoveryStoreError) throw cause;
      fail("recovery-storage-unavailable", "firmware recovery marker could not be persisted", { cause });
    }
    return marker;
  }

  #cacheName(packageSha256) {
    return `${RECOVERY_PACKAGE_CACHE_PREFIX}${requireHash(packageSha256, "firmware package identity")}`;
  }

  #recordUrl(packageSha256) {
    return `${this.origin}/__sauna_firmware_recovery__/v1/${packageSha256}/record.json`;
  }

  #imageUrl(packageSha256, index, role) {
    return `${this.origin}/__sauna_firmware_recovery__/v1/${packageSha256}/${index}-${role}.bin`;
  }

  async #open(packageSha256) {
    if (!this.cacheStorage || typeof this.cacheStorage.open !== "function") {
      fail("recovery-cache-unavailable", "firmware recovery cache is unavailable");
    }
    try {
      return await this.cacheStorage.open(this.#cacheName(packageSha256));
    } catch (cause) {
      fail("recovery-cache-unavailable", "firmware recovery cache could not be opened", { cause });
    }
  }

  async persistPreparedPackage(prepared) {
    const validated = await revalidatePrepared(prepared, this.digest);
    const packageSha256 = validated.packageSha256;
    const cache = await this.#open(packageSha256);
    const savedAt = asTimestamp(this.now);
    try {
      // The record is the commit point. Image writes are idempotent because
      // the cache name and manifest both commit to every image SHA-256.
      for (const [index, file] of validated.files.entries()) {
        await cache.put(
          this.#imageUrl(packageSha256, index, file.role),
          new Response(new Uint8Array(file.data), {
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Content-SHA256": file.sha256,
            },
          }),
        );
      }
      const record = {
        schemaVersion: PACKAGE_RECORD_SCHEMA_VERSION,
        packageSha256,
        manifestUrl: validated.manifestUrl,
        manifest: validated.manifest,
        savedAt,
      };
      await cache.put(
        this.#recordUrl(packageSha256),
        new Response(JSON.stringify(record), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch (cause) {
      fail("recovery-cache-unavailable", "exact firmware recovery package could not be persisted", { cause });
    }
    return this.restorePreparedPackage(packageSha256);
  }

  async #readRecord(packageSha256) {
    const cache = await this.#open(packageSha256);
    let response;
    try {
      response = await cache.match(this.#recordUrl(packageSha256));
    } catch (cause) {
      fail("recovery-cache-unavailable", "firmware recovery record could not be read", { cause });
    }
    if (!response) {
      fail("recovery-package-missing", "the exact firmware recovery package is not cached");
    }
    let record;
    try {
      record = await response.json();
    } catch (cause) {
      fail("recovery-package-invalid", "firmware recovery record is damaged", { cause });
    }
    requireExactKeys(
      record,
      ["schemaVersion", "packageSha256", "manifestUrl", "manifest", "savedAt"],
      "firmware recovery package record",
    );
    if (record.schemaVersion !== PACKAGE_RECORD_SCHEMA_VERSION) {
      fail("recovery-package-invalid", "firmware recovery package schema is unsupported");
    }
    if (record.packageSha256 !== packageSha256) {
      fail("recovery-package-mismatch", "cached firmware package has the wrong identity");
    }
    requireTimestamp(record.savedAt, "firmware package save time");
    if (typeof record.manifestUrl !== "string") {
      fail("recovery-package-invalid", "cached firmware manifest URL is invalid");
    }
    return { cache, record };
  }

  async restorePreparedPackage(packageSha256) {
    requireHash(packageSha256, "firmware package identity");
    const { cache, record } = await this.#readRecord(packageSha256);
    const loaded = new Map();
    const loadFile = async (_url, file) => {
      const index = record.manifest?.files?.findIndex(
        (candidate) => candidate.role === file.role && candidate.path === file.path,
      );
      if (index < 0) {
        fail("recovery-package-invalid", `cached ${file.role} image is not declared`);
      }
      let response;
      try {
        response = await cache.match(this.#imageUrl(packageSha256, index, file.role));
      } catch (cause) {
        fail("recovery-cache-unavailable", `cached ${file.role} image could not be read`, { cause });
      }
      if (!response) fail("recovery-package-missing", `cached ${file.role} image is missing`);
      let data;
      try {
        data = new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        fail("recovery-package-invalid", `cached ${file.role} image is damaged`, { cause });
      }
      loaded.set(file.path, data);
      return data;
    };
    const restored = await prepareFirmwarePackage(record.manifest, {
      manifestUrl: record.manifestUrl,
      loadFile,
      digest: this.digest,
    });
    if (restored.packageSha256 !== packageSha256 || loaded.size !== 4) {
      fail("recovery-package-mismatch", "cached firmware package failed identity verification");
    }
    return restored;
  }

  async restoreLatestPreparedPackage() {
    if (!this.cacheStorage || typeof this.cacheStorage.keys !== "function") {
      fail("recovery-cache-unavailable", "firmware recovery cache is unavailable");
    }
    let names;
    try {
      names = await this.cacheStorage.keys();
    } catch (cause) {
      fail("recovery-cache-unavailable", "cached firmware packages could not be listed", { cause });
    }
    const candidates = [];
    for (const name of names) {
      if (!name.startsWith(RECOVERY_PACKAGE_CACHE_PREFIX)) continue;
      const packageSha256 = name.slice(RECOVERY_PACKAGE_CACHE_PREFIX.length);
      if (!SHA256.test(packageSha256)) continue;
      try {
        const { record } = await this.#readRecord(packageSha256);
        candidates.push({ packageSha256, savedAt: record.savedAt });
      } catch {
        // A damaged unrelated cache cannot displace another valid package.
      }
    }
    candidates.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    let lastError = null;
    for (const candidate of candidates) {
      try {
        return await this.restorePreparedPackage(candidate.packageSha256);
      } catch (error) {
        lastError = error;
      }
    }
    fail(
      "recovery-package-missing",
      "no complete validated firmware package is available offline",
      lastError ? { cause: lastError } : undefined,
    );
  }

  async beginWrite({ packageSha256, deviceIdHash, expectation }) {
    this.#requireLifecycle();
    if (this.readMarker()) {
      fail(
        "recovery-record-conflict",
        "another firmware recovery record already requires attention",
      );
    }
    // Cache validation deliberately happens before the marker commit. The
    // controller must be built from this same restored package, and no write
    // call is made until the marker round-trips through localStorage.
    const restored = await this.restorePreparedPackage(packageSha256);
    const normalizedExpectation = validateFirmwareExpectation(expectation);
    if (!expectationMatches(normalizedExpectation, expectationFromPrepared(restored))) {
      fail(
        "recovery-package-mismatch",
        "firmware verification target does not match the cached package",
      );
    }
    if (this.readMarker()) {
      fail(
        "recovery-record-conflict",
        "another firmware recovery record appeared while the package was checked",
      );
    }
    const timestamp = asTimestamp(this.now);
    return this.writeMarker({
      schemaVersion: MARKER_SCHEMA_VERSION,
      phase: RecoveryPhase.WRITE_REQUIRED,
      packageSha256,
      deviceIdHash,
      expectation: normalizedExpectation,
      startedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  markVerificationRequired() {
    this.#requireLifecycle();
    const current = this.readMarker();
    if (!current) fail("recovery-record-missing", "firmware recovery marker is missing");
    return this.writeMarker({
      ...current,
      phase: RecoveryPhase.VERIFICATION_REQUIRED,
      updatedAt: asTimestamp(this.now),
    });
  }

  async completeVerifiedFirmware({ packageSha256, deviceIdHash, expectation }) {
    this.#requireLifecycle();
    const current = this.readMarker();
    if (!current) fail("recovery-record-missing", "firmware verification marker is missing");
    if (
      current.phase !== RecoveryPhase.VERIFICATION_REQUIRED ||
      current.packageSha256 !== packageSha256 ||
      current.deviceIdHash !== deviceIdHash ||
      !expectationMatches(current.expectation, validateFirmwareExpectation(expectation))
    ) {
      fail("recovery-package-mismatch", "verified firmware does not match the mandatory recovery record");
    }
    try {
      this.storage.removeItem(RECOVERY_STORAGE_KEY);
      if (this.storage.getItem(RECOVERY_STORAGE_KEY) !== null) {
        fail("recovery-storage-unavailable", "verified firmware marker could not be cleared");
      }
    } catch (cause) {
      if (cause instanceof FirmwareRecoveryStoreError) throw cause;
      fail("recovery-storage-unavailable", "verified firmware marker could not be cleared", { cause });
    }
    // The immutable, hash-keyed package is intentionally retained. It is a
    // safe offline install source and can never satisfy a different marker.
    await this.releaseLifecycle();
    return true;
  }
}

export async function restoreOrRepairRecoveryPackage({
  store,
  marker,
  downloadPackage,
}) {
  if (!(store instanceof FirmwareRecoveryStore)) {
    throw new TypeError("store must be a FirmwareRecoveryStore");
  }
  const normalizedMarker = validateRecoveryMarker(marker);
  let restored = null;
  try {
    restored = await store.restorePreparedPackage(
      normalizedMarker.packageSha256,
    );
  } catch (error) {
    if (!REPAIRABLE_PACKAGE_ERRORS.has(String(error?.code ?? ""))) throw error;
  }
  if (restored) return requireExactMarkerPackage(normalizedMarker, restored);
  if (typeof downloadPackage !== "function") {
    fail("recovery-package-missing", "the exact recovery package is not cached");
  }
  const downloaded = await downloadPackage();
  const validated = await revalidatePrepared(downloaded, store.digest);
  requireExactMarkerPackage(normalizedMarker, validated);
  const persisted = await store.persistPreparedPackage(validated);
  return requireExactMarkerPackage(normalizedMarker, persisted);
}
