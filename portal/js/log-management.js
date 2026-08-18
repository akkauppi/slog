import { ProtocolError } from "./protocol.js";
import {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  MAXIMUM_SERIAL_RX_LINE_LENGTH,
  ProtocolTimeoutError,
} from "./serial-transport.js";

// A firmware segment is bounded to ~111 KiB. Keep the browser bound aligned
// with the 128 KiB parser envelope so every accepted transfer can finish well
// inside the overall 115200-baud timeout.
export const DEFAULT_MAX_LOG_BYTES = 128 * 1024;
export const DEFAULT_LIST_INACTIVITY_TIMEOUT_MS = 8000;
export const DEFAULT_LIST_OVERALL_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 8000;
export const DEFAULT_DOWNLOAD_MINIMUM_OVERALL_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_MAXIMUM_OVERALL_TIMEOUT_MS = 360_000;
export const DEFAULT_DOWNLOAD_MILLISECONDS_PER_BYTE = 0.25;

const UINT32_MAX = 0xffffffff;
const CRC32_TEXT = /^[0-9A-Fa-f]{8}$/;
const HEX_DATA = /^[0-9A-Fa-f]+$/;
const ISSUE = Symbol("issue verified log object");
const DOWNLOAD_STATE = new WeakMap();
const RECEIPT_STATE = new WeakMap();

export class LogDeviceError extends Error {
  constructor(code, message = `logger refused operation: ${code}`) {
    super(message);
    this.name = "LogDeviceError";
    this.code = code;
  }
}

export class PreservationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PreservationError";
  }
}

export class DeletionOutcomeUncertainError extends Error {
  constructor(sessionId, options) {
    super(
      `deletion outcome for session ${sessionId} is uncertain; reconnect and refresh the log list`,
      options,
    );
    this.name = "DeletionOutcomeUncertainError";
    this.sessionId = sessionId;
  }
}

export class VerifiedLogDownload {
  constructor(key, state) {
    if (key !== ISSUE) throw new TypeError("verified downloads are issued by LogManager");
    DOWNLOAD_STATE.set(this, state);
    Object.freeze(this);
  }

  get sessionId() {
    return DOWNLOAD_STATE.get(this).sessionId;
  }

  get size() {
    return DOWNLOAD_STATE.get(this).bytes.byteLength;
  }

  get crc32() {
    return DOWNLOAD_STATE.get(this).crc32;
  }

  get suggestedName() {
    return `session-${this.sessionId}.slog`;
  }

  bytes() {
    return DOWNLOAD_STATE.get(this).bytes.slice();
  }

  arrayBuffer() {
    return this.bytes().buffer;
  }
}

export class PreservationReceipt {
  constructor(key, state) {
    if (key !== ISSUE) throw new TypeError("preservation receipts are issued by LogManager");
    RECEIPT_STATE.set(this, state);
    Object.freeze(this);
  }

  get sessionId() {
    return RECEIPT_STATE.get(this).sessionId;
  }

  get size() {
    return RECEIPT_STATE.get(this).bytes.byteLength;
  }

  get crc32() {
    return RECEIPT_STATE.get(this).crc32;
  }

  get filename() {
    return RECEIPT_STATE.get(this).filename;
  }

  get used() {
    return RECEIPT_STATE.get(this).used;
  }
}

function asLogMessage(value) {
  if (typeof value !== "string") return value;
  if (value.length > MAXIMUM_SERIAL_RX_LINE_LENGTH) {
    throw new ProtocolError("log protocol line is too long");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      throw new ProtocolError("log protocol line is not ASCII");
    }
  }
  const text = value.replace(/[\r\n]+$/, "");
  const tokens = text.trim().split(/\s+/);
  const name = tokens[0];
  if (!/^LOG_[A-Z0-9_]+$/.test(name)) {
    throw new ProtocolError(`invalid log message name: ${JSON.stringify(name)}`);
  }
  const fields = Object.create(null);
  for (const token of tokens.slice(1)) {
    const separator = token.indexOf("=");
    const key = separator < 0 ? token : token.slice(0, separator);
    const fieldValue = separator < 0 ? "" : token.slice(separator + 1);
    if (separator < 1 || !fieldValue || !/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new ProtocolError(`invalid log protocol field: ${JSON.stringify(token)}`);
    }
    if (Object.hasOwn(fields, key)) {
      throw new ProtocolError(`duplicate log protocol field: ${key}`);
    }
    fields[key] = fieldValue;
  }
  return Object.freeze({ name, fields: Object.freeze(fields) });
}

function required(message, field) {
  if (!message?.fields || !Object.hasOwn(message.fields, field)) {
    throw new ProtocolError(`${message?.name ?? "message"} is missing ${field}`);
  }
  return message.fields[field];
}

function unsigned(message, field, maximum = Number.MAX_SAFE_INTEGER) {
  const text = required(message, field);
  if (!/^[0-9]+$/.test(text)) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(text)}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new ProtocolError(`${message.name} has unsafe ${field}: ${JSON.stringify(text)}`);
  }
  return value;
}

function signed(message, field) {
  const text = required(message, field);
  if (!/^-?[0-9]+$/.test(text)) {
    throw new ProtocolError(`${message.name} has invalid ${field}: ${JSON.stringify(text)}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new ProtocolError(`${message.name} has unsafe ${field}: ${JSON.stringify(text)}`);
  }
  return value;
}

function booleanField(message, field) {
  const value = unsigned(message, field, 1);
  if (value !== 0 && value !== 1) {
    throw new ProtocolError(`${message.name} has invalid ${field}`);
  }
  return value === 1;
}

function crcField(message) {
  const value = required(message, "crc32").toUpperCase();
  if (!CRC32_TEXT.test(value)) {
    throw new ProtocolError(`${message.name} has invalid crc32: ${JSON.stringify(value)}`);
  }
  return value;
}

function sessionId(value) {
  if (!Number.isInteger(value) || value < 1 || value > UINT32_MAX) {
    throw new ProtocolError(`invalid session id: ${JSON.stringify(value)}`);
  }
  return value;
}

function freezeRecord(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) Object.freeze(child);
  }
  return Object.freeze(value);
}

function throwIfLogError(line) {
  const match = /^LOG_ERROR(?:\s+([^\s]+))?\s*$/.exec(line);
  if (!match) return;
  const code = match[1] ?? "unknown";
  if (!/^[a-z0-9_]+$/.test(code)) {
    throw new ProtocolError(`malformed LOG_ERROR: ${JSON.stringify(line)}`);
  }
  throw new LogDeviceError(code);
}

export function parseLogStatus(value) {
  const message = asLogMessage(value);
  if (message.name !== "LOG_STATUS") {
    throw new ProtocolError(`expected LOG_STATUS, found ${message.name}`);
  }
  const filesystemReady = booleanField(message, "fs");
  const active = booleanField(message, "active");
  const activeSessionId = unsigned(message, "id", UINT32_MAX);
  const totalBytes = unsigned(message, "total");
  const usedBytes = unsigned(message, "used");
  const freeBytes = unsigned(message, "free");
  const interruptedSessionId = unsigned(message, "interrupted", UINT32_MAX);
  const coredumpPresent = booleanField(message, "coredump");
  const coredumpBytes = unsigned(message, "coredump_bytes");
  const retentionPolicy = required(message, "retention");
  const reserveOk = booleanField(message, "reserve_ok");
  const reserveRequiredBytes = unsigned(message, "reserve_required");
  const commissioning = booleanField(message, "commissioning");
  const restartRequired = booleanField(message, "restart_required");
  const protocol = unsigned(message, "protocol");
  const continuationPendingSessionId = Object.hasOwn(
    message.fields,
    "continuation_pending",
  )
    ? unsigned(message, "continuation_pending", UINT32_MAX)
    : null;

  if (usedBytes > totalBytes || freeBytes !== totalBytes - usedBytes) {
    throw new ProtocolError("LOG_STATUS storage byte counts are inconsistent");
  }
  if (active && activeSessionId === 0) {
    throw new ProtocolError("LOG_STATUS reports an active session with id zero");
  }
  if (!active && activeSessionId !== 0) {
    throw new ProtocolError("LOG_STATUS reports an inactive logger with a current id");
  }
  if (!filesystemReady && (active || totalBytes || usedBytes || freeBytes)) {
    throw new ProtocolError("LOG_STATUS reports storage activity while filesystem is unavailable");
  }
  if (!coredumpPresent && coredumpBytes !== 0) {
    throw new ProtocolError("LOG_STATUS reports bytes for an absent coredump");
  }
  if (retentionPolicy !== "rolling") {
    throw new ProtocolError(`unsupported retention policy: ${JSON.stringify(retentionPolicy)}`);
  }
  if (protocol !== 1) {
    throw new ProtocolError(`unsupported log protocol: ${protocol}`);
  }

  return freezeRecord({
    filesystemReady,
    active,
    activeSessionId,
    totalBytes,
    usedBytes,
    freeBytes,
    interruptedSessionId,
    continuationPendingSessionId,
    coredumpPresent,
    coredumpBytes,
    commissioning,
    restartRequired,
    protocol,
    validSensors: unsigned(message, "sensors"),
    retention: {
      policy: retentionPolicy,
      reserveOk,
      reserveRequiredBytes,
      deletedRuns: unsigned(message, "retention_deleted_runs"),
      deletedSegments: unsigned(message, "retention_deleted_segments"),
      lastDeletedRun: unsigned(message, "retention_last_run", UINT32_MAX),
      lastDeletedSegment: unsigned(message, "retention_last_segment", UINT32_MAX),
      pendingSegment: unsigned(message, "retention_pending", UINT32_MAX),
      pendingRun: unsigned(message, "retention_pending_root", UINT32_MAX),
      highestSessionId: unsigned(message, "retention_highest_session", UINT32_MAX),
      catalogOverflow: booleanField(message, "retention_catalog_overflow"),
      catalogInvalid: booleanField(message, "retention_catalog_invalid"),
      auditOk: booleanField(message, "retention_audit_ok"),
      lastRefusal: required(message, "retention_last_refusal"),
    },
  });
}

function parseSessionMessage(value) {
  const message = asLogMessage(value);
  if (message.name !== "LOG_SESSION") {
    throw new ProtocolError(`expected LOG_SESSION, found ${message.name}`);
  }
  const state = required(message, "state");
  if (state !== "finalized" && state !== "interrupted") {
    throw new ProtocolError(`LOG_SESSION has unknown state: ${JSON.stringify(state)}`);
  }
  const result = {
    id: unsigned(message, "id", UINT32_MAX),
    bytes: unsigned(message, "bytes"),
    state,
    reason: unsigned(message, "reason"),
    version: unsigned(message, "version"),
    bootId: unsigned(message, "boot", UINT32_MAX),
    resetReason: unsigned(message, "reset"),
    continuationOf: unsigned(message, "continuation_of", UINT32_MAX),
    continuationKind: unsigned(message, "continuation_kind"),
  };
  sessionId(result.id);
  return Object.freeze(result);
}

export function parseLogList(values) {
  if (!Array.isArray(values)) throw new TypeError("log list response must be an array");
  if (values.length < 2) {
    throw new ProtocolError("log list response is incomplete");
  }
  const begin = asLogMessage(values[0]);
  const end = asLogMessage(values.at(-1));
  if (begin.name !== "LOG_LIST_BEGIN") {
    throw new ProtocolError("log list response is missing LOG_LIST_BEGIN");
  }
  if (end.name !== "LOG_LIST_END") {
    throw new ProtocolError("log list response is missing LOG_LIST_END");
  }
  const sessions = [];
  const entryIssues = [];
  for (const [index, value] of values.slice(1, -1).entries()) {
    try {
      sessions.push(parseSessionMessage(value));
    } catch (error) {
      entryIssues.push(Object.freeze({
        code: "malformed_session_entry",
        entry: index + 1,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  Object.defineProperty(sessions, "entryIssues", {
    enumerable: false,
    value: Object.freeze(entryIssues),
  });
  return Object.freeze(sessions);
}

/** Return grouping plus safety issues without hiding malformed raw entries. */
export function inspectContinuationCatalog(sessions) {
  if (!Array.isArray(sessions)) throw new TypeError("sessions must be an array");
  const issues = Array.isArray(sessions.entryIssues)
    ? [...sessions.entryIssues]
    : [];
  const byId = new Map();
  for (const entry of sessions) {
    if (byId.has(entry.id)) {
      issues.push(Object.freeze({ code: "duplicate_id", sessionId: entry.id }));
    } else {
      byId.set(entry.id, entry);
    }
    if (entry.bytes === 0) {
      issues.push(Object.freeze({ code: "empty_session", sessionId: entry.id }));
    }
    if (entry.version !== 1 && entry.version !== 2) {
      issues.push(Object.freeze({
        code: "unsupported_version",
        sessionId: entry.id,
        version: entry.version,
      }));
    }
    if (entry.state === "finalized" && ![1, 2, 3].includes(entry.reason)) {
      issues.push(Object.freeze({
        code: "invalid_finish_reason",
        sessionId: entry.id,
        reason: entry.reason,
      }));
    }
    if (entry.state === "interrupted" && entry.reason !== 0) {
      issues.push(Object.freeze({
        code: "interrupted_finish_reason",
        sessionId: entry.id,
        reason: entry.reason,
      }));
    }
    const kindInvalid = entry.version === 1
      ? entry.continuationKind !== 0
      : entry.continuationKind > 3 ||
        (entry.continuationOf === 0) !== (entry.continuationKind === 0);
    if (kindInvalid) {
      issues.push(Object.freeze({
        code: "invalid_continuation_kind",
        sessionId: entry.id,
        continuationKind: entry.continuationKind,
      }));
    }
  }

  const successors = new Map();
  for (const entry of sessions) {
    if (!entry.continuationOf) continue;
    if (entry.id <= entry.continuationOf) {
      issues.push(Object.freeze({
        code: "non_monotonic_continuation",
        sessionId: entry.id,
        predecessorId: entry.continuationOf,
      }));
    }
    if (entry.continuationOf === entry.id) {
      issues.push(Object.freeze({ code: "self_continuation", sessionId: entry.id }));
    } else if (!byId.has(entry.continuationOf)) {
      issues.push(Object.freeze({
        code: "missing_predecessor",
        sessionId: entry.id,
        predecessorId: entry.continuationOf,
      }));
    }
    const children = successors.get(entry.continuationOf) ?? [];
    children.push(entry);
    successors.set(entry.continuationOf, children);
  }
  for (const [predecessorId, children] of successors) {
    if (children.length > 1) {
      issues.push(Object.freeze({
        code: "multiple_successors",
        predecessorId,
        sessionIds: Object.freeze(children.map((entry) => entry.id).sort((a, b) => a - b)),
      }));
    }
  }

  for (const entry of sessions) {
    const path = new Set();
    let current = entry;
    while (current?.continuationOf) {
      if (path.has(current.id)) {
        issues.push(Object.freeze({ code: "continuation_cycle", sessionId: entry.id }));
        break;
      }
      path.add(current.id);
      current = byId.get(current.continuationOf);
    }
  }

  const runs = [];
  if (!issues.length) {
    const roots = sessions
      .filter((entry) => entry.continuationOf === 0)
      .sort((left, right) => left.id - right.id);
    for (const root of roots) {
      const run = [root];
      let current = root;
      while (successors.get(current.id)?.length === 1) {
        [current] = successors.get(current.id);
        run.push(current);
      }
      runs.push(Object.freeze(run));
    }
    if (runs.reduce((count, run) => count + run.length, 0) !== sessions.length) {
      issues.push(Object.freeze({ code: "unreachable_session" }));
      runs.length = 0;
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
    runs: Object.freeze(runs),
  });
}

export function crc32(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("CRC input must be bytes");
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crcText(bytes) {
  return crc32(bytes).toString(16).toUpperCase().padStart(8, "0");
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readFileHandle(fileHandle) {
  if (!fileHandle || typeof fileHandle.getFile !== "function") {
    throw new TypeError("a readable FileSystemFileHandle is required");
  }
  const file = await fileHandle.getFile();
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new PreservationError("saved log cannot be read back");
  }
  return new Uint8Array(await file.arrayBuffer());
}

export class LogManager {
  constructor(transport, {
    timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
    listInactivityTimeoutMs = DEFAULT_LIST_INACTIVITY_TIMEOUT_MS,
    listOverallTimeoutMs = DEFAULT_LIST_OVERALL_TIMEOUT_MS,
    downloadInactivityTimeoutMs = DEFAULT_DOWNLOAD_INACTIVITY_TIMEOUT_MS,
    downloadMinimumOverallTimeoutMs = DEFAULT_DOWNLOAD_MINIMUM_OVERALL_TIMEOUT_MS,
    downloadMaximumOverallTimeoutMs = DEFAULT_DOWNLOAD_MAXIMUM_OVERALL_TIMEOUT_MS,
    downloadMillisecondsPerByte = DEFAULT_DOWNLOAD_MILLISECONDS_PER_BYTE,
    maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  } = {}) {
    if (!transport || typeof transport.writeLine !== "function" ||
        typeof transport.readRecord !== "function") {
      throw new TypeError("a serial transport is required");
    }
    for (const [name, value] of Object.entries({
      timeoutMs,
      listInactivityTimeoutMs,
      listOverallTimeoutMs,
      downloadInactivityTimeoutMs,
      downloadMinimumOverallTimeoutMs,
      downloadMaximumOverallTimeoutMs,
      maxLogBytes,
    })) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
    }
    if (!Number.isFinite(downloadMillisecondsPerByte) || downloadMillisecondsPerByte < 0) {
      throw new TypeError("downloadMillisecondsPerByte must not be negative");
    }
    if (listInactivityTimeoutMs > listOverallTimeoutMs) {
      throw new TypeError("list inactivity timeout exceeds overall timeout");
    }
    if (downloadMinimumOverallTimeoutMs > downloadMaximumOverallTimeoutMs) {
      throw new TypeError("minimum download timeout exceeds maximum");
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.listInactivityTimeoutMs = listInactivityTimeoutMs;
    this.listOverallTimeoutMs = listOverallTimeoutMs;
    this.downloadInactivityTimeoutMs = downloadInactivityTimeoutMs;
    this.downloadMinimumOverallTimeoutMs = downloadMinimumOverallTimeoutMs;
    this.downloadMaximumOverallTimeoutMs = downloadMaximumOverallTimeoutMs;
    this.downloadMillisecondsPerByte = downloadMillisecondsPerByte;
    this.maxLogBytes = maxLogBytes;
    this._tail = Promise.resolve();
  }

  status() {
    return this._enqueue(() => this._statusUnlocked());
  }

  list() {
    return this._enqueue(() => this._listUnlocked());
  }

  download(value) {
    const id = sessionId(value);
    return this._enqueue(async () => {
      const status = await this._statusUnlocked();
      if (!status.filesystemReady) throw new LogDeviceError("fs_unavailable");
      if (status.active) {
        throw new LogDeviceError("active_session", "logs cannot be transferred during an active session");
      }
      return this._downloadUnlocked(id);
    });
  }

  async preserveToFile(download, fileHandle) {
    const state = DOWNLOAD_STATE.get(download);
    if (!state || state.owner !== this) {
      throw new PreservationError("download was not verified by this browser flow");
    }
    if (!fileHandle || typeof fileHandle.createWritable !== "function") {
      throw new TypeError("a writable FileSystemFileHandle is required");
    }
    let writable;
    try {
      writable = await fileHandle.createWritable({ keepExistingData: false });
      if (!writable || typeof writable.write !== "function" ||
          typeof writable.close !== "function") {
        throw new PreservationError("file handle did not provide a writable stream");
      }
      await writable.write(state.bytes.slice());
      await writable.close();
    } catch (error) {
      try {
        await writable?.abort?.();
      } catch {
        // Preserve the write/close failure.
      }
      if (error instanceof PreservationError) throw error;
      throw new PreservationError("could not preserve the raw log", { cause: error });
    }

    let saved;
    try {
      saved = await readFileHandle(fileHandle);
    } catch (error) {
      if (error instanceof PreservationError) throw error;
      throw new PreservationError("could not verify the saved raw log", { cause: error });
    }
    if (crcText(saved) !== state.crc32 || !sameBytes(saved, state.bytes)) {
      throw new PreservationError("saved raw log does not match the verified device bytes");
    }
    const filename = typeof fileHandle.name === "string" && fileHandle.name
      ? fileHandle.name
      : download.suggestedName;
    return new PreservationReceipt(ISSUE, {
      owner: this,
      sessionId: state.sessionId,
      crc32: state.crc32,
      bytes: state.bytes.slice(),
      fileHandle,
      filename,
      used: false,
    });
  }

  deletePreserved(receipt) {
    const receiptState = RECEIPT_STATE.get(receipt);
    if (!receiptState || receiptState.owner !== this) {
      return Promise.reject(new PreservationError(
        "deletion requires a preservation receipt from this browser flow",
      ));
    }
    if (receiptState.used) {
      return Promise.reject(new PreservationError("preservation receipt has already been used"));
    }
    return this._enqueue(async () => {
      // Re-check inside the queue in case a prior queued deletion used it.
      if (receiptState.used) {
        throw new PreservationError("preservation receipt has already been used");
      }
      const archived = await readFileHandle(receiptState.fileHandle);
      if (crcText(archived) !== receiptState.crc32 ||
          !sameBytes(archived, receiptState.bytes)) {
        throw new PreservationError("preserved raw log changed after verification");
      }
      await this._deleteVerifiedState(receiptState);
      receiptState.used = true;
      return Object.freeze({ sessionId: receiptState.sessionId });
    });
  }

  deleteDownloaded(download) {
    const downloadState = DOWNLOAD_STATE.get(download);
    if (!downloadState || downloadState.owner !== this) {
      return Promise.reject(new PreservationError(
        "override deletion requires a verified download from this browser flow",
      ));
    }
    const expected = {
      sessionId: downloadState.sessionId,
      crc32: downloadState.crc32,
      bytes: downloadState.bytes.slice(),
    };
    return this._enqueue(async () => {
      await this._deleteVerifiedState(expected);
      return Object.freeze({ sessionId: expected.sessionId });
    });
  }

  async _deleteVerifiedState(expected) {
    const status = await this._statusUnlocked();
    if (!status.filesystemReady) throw new LogDeviceError("fs_unavailable");
    if (status.active) {
      throw new LogDeviceError("active_session", "logs cannot be deleted during an active session");
    }
    if (status.commissioning || status.restartRequired) {
      throw new LogDeviceError(
        "configuration_unresolved",
        "logs cannot be deleted while commissioning or restart is unresolved",
      );
    }
    if (!status.retention.auditOk) {
      throw new LogDeviceError(
        "retention_audit_unavailable",
        "logs cannot be deleted while the retention audit is unavailable",
      );
    }
    if (status.retention.catalogInvalid || status.retention.catalogOverflow) {
      throw new LogDeviceError(
        "retention_catalog_invalid",
        "logs cannot be deleted while the logger catalog is invalid or incomplete",
      );
    }
    if (status.retention.pendingSegment || status.retention.pendingRun) {
      throw new LogDeviceError(
        "retention_pending",
        "logs cannot be deleted while automatic retention is pending",
      );
    }
    if (status.continuationPendingSessionId === null) {
      throw new LogDeviceError(
        "firmware_update_required",
        "firmware does not expose the continuation protection needed for safe deletion",
      );
    }

    const sessions = await this._listUnlocked();
    const catalog = inspectContinuationCatalog(sessions);
    if (!catalog.valid) {
      throw new LogDeviceError(
        "catalog_invalid",
        "session relationships are inconsistent; deletion is disabled",
      );
    }
    const listed = sessions.find((entry) => entry.id === expected.sessionId);
    if (!listed) throw new LogDeviceError("not_found");
    if (listed.bytes !== expected.bytes.byteLength) {
      throw new PreservationError("device log size changed after validation");
    }
    if (sessions.some((entry) => entry.continuationOf === expected.sessionId)) {
      throw new LogDeviceError(
        "continuation_exists",
        "delete continuation segments from newest to oldest",
      );
    }
    if (status.continuationPendingSessionId) {
      const rootOf = (id) => {
        const seen = new Set();
        let current = sessions.find((entry) => entry.id === id);
        if (!current) return null;
        while (current.continuationOf) {
          if (seen.has(current.id)) return null;
          seen.add(current.id);
          current = sessions.find((entry) => entry.id === current.continuationOf);
          if (!current) return null;
        }
        return current.id;
      };
      const pendingRoot = rootOf(status.continuationPendingSessionId);
      const selectedRoot = rootOf(expected.sessionId);
      if (pendingRoot === null || selectedRoot === null) {
        throw new LogDeviceError(
          "continuation_state_invalid",
          "logger continuation state does not match its session catalog",
        );
      }
      if (pendingRoot === selectedRoot) {
        throw new LogDeviceError(
          "probable_continuation",
          "this run may still be continued after power restoration",
        );
      }
    }

    const current = await this._downloadUnlocked(expected.sessionId);
    const currentState = DOWNLOAD_STATE.get(current);
    if (currentState.crc32 !== expected.crc32 ||
        !sameBytes(currentState.bytes, expected.bytes)) {
      throw new PreservationError("device log no longer matches the validated download");
    }

    try {
      // From this point onward even a rejected write may have put some or all
      // command bytes on USB. Only an explicit, matching acknowledgement can
      // establish the outcome.
      await this.transport.writeLine(`LOG DELETE ${expected.sessionId}`);
      const message = await this._readSingleLogMessage("LOG_DELETE", "LOG DELETE");
      const acknowledgedId = unsigned(message, "id", UINT32_MAX);
      if (acknowledgedId !== expected.sessionId) {
        throw new ProtocolError("LOG_DELETE acknowledged the wrong session id");
      }
      if (!booleanField(message, "ok")) {
        throw new LogDeviceError("delete_failed", "logger did not confirm deletion");
      }
    } catch (error) {
      // A syntactically valid device refusal proves that this command did not
      // remove the session. Every other missing/untrusted ack is ambiguous.
      if (error instanceof LogDeviceError) throw error;
      throw new DeletionOutcomeUncertainError(expected.sessionId, { cause: error });
    }
  }

  _enqueue(operation) {
    if (typeof this.transport.runExclusive === "function") {
      return this.transport.runExclusive(operation);
    }
    const result = this._tail.then(operation, operation);
    this._tail = result.catch(() => {});
    return result;
  }

  async _statusUnlocked() {
    await this.transport.writeLine("LOG STATUS");
    return parseLogStatus(await this._readSingleLogMessage("LOG_STATUS", "LOG STATUS"));
  }

  async _listUnlocked() {
    await this.transport.writeLine("LOG LIST");
    const deadline = Date.now() + this.listOverallTimeoutMs;
    const messages = [];
    let started = false;
    while (Date.now() < deadline) {
      const record = await this._readRecordWithin(
        deadline,
        this.listInactivityTimeoutMs,
        "LOG LIST",
      );
      if (record.error) {
        if (started || record.linePrefix?.startsWith("LOG_")) throw record.error;
        continue;
      }
      const line = record.line;
      if (!line || line.startsWith("TELEM ")) continue;
      throwIfLogError(line);
      if (started && line.startsWith("LOG_SESSION")) {
        // Preserve malformed per-file entries for parseLogList() to report
        // without hiding every other valid, independently downloadable log.
        messages.push(line);
        continue;
      }
      let message;
      try {
        message = asLogMessage(line);
      } catch (error) {
        if (line.startsWith("LOG_")) throw error;
        continue;
      }
      if (!started) {
        if (message.name !== "LOG_LIST_BEGIN") {
          if (message.name.startsWith("LOG_")) {
            throw new ProtocolError(`unexpected log response: ${message.name}`);
          }
          continue;
        }
        started = true;
        messages.push(message);
        continue;
      }
      if (message.name === "LOG_LIST_END") {
        messages.push(message);
        return parseLogList(messages);
      }
      if (message.name.startsWith("LOG_")) {
        throw new ProtocolError(`unexpected log response: ${message.name}`);
      }
      // TELEM and runtime/logger chatter may interleave with the frame.
    }
    throw new ProtocolTimeoutError("timed out waiting for response to \"LOG LIST\"");
  }

  async _downloadUnlocked(id) {
    await this.transport.writeLine(`LOG GET ${id}`);
    const beginDeadline = Date.now() + this.timeoutMs;
    let overallDeadline = null;
    let expectedSize = null;
    let expectedCrc = null;
    let received = 0;
    const chunks = [];

    while (true) {
      const deadline = overallDeadline ?? beginDeadline;
      if (Date.now() >= deadline) {
        throw new ProtocolTimeoutError(`timed out downloading session ${id}`);
      }
      const record = await this._readRecordWithin(
        deadline,
        expectedSize === null ? this.timeoutMs : this.downloadInactivityTimeoutMs,
        `LOG GET ${id}`,
      );
      if (record.error) {
        if (expectedSize !== null || record.linePrefix?.startsWith("LOG_")) throw record.error;
        continue;
      }
      const line = record.line;
      if (!line || line.startsWith("TELEM ")) continue;
      throwIfLogError(line);

      if (expectedSize === null) {
        if (!line.startsWith("LOG_DATA_BEGIN")) {
          if (line.startsWith("LOG_")) {
            throw new ProtocolError(`unexpected log response before download: ${line}`);
          }
          continue;
        }
        const message = asLogMessage(line);
        if (message.name !== "LOG_DATA_BEGIN") {
          throw new ProtocolError(`expected LOG_DATA_BEGIN, found ${message.name}`);
        }
        const responseId = unsigned(message, "id", UINT32_MAX);
        if (responseId !== id) throw new ProtocolError("download began for the wrong session id");
        expectedSize = unsigned(message, "bytes");
        if (expectedSize === 0 || expectedSize > this.maxLogBytes) {
          throw new ProtocolError(`announced log size is outside the allowed bound: ${expectedSize}`);
        }
        expectedCrc = crcField(message);
        const derived = Math.max(
          this.downloadMinimumOverallTimeoutMs,
          this.downloadMinimumOverallTimeoutMs +
            expectedSize * this.downloadMillisecondsPerByte,
        );
        overallDeadline = Date.now() + Math.min(
          this.downloadMaximumOverallTimeoutMs,
          derived,
        );
        continue;
      }

      if (line.startsWith("LOG_DATA ")) {
        const text = line.slice("LOG_DATA ".length);
        if (!text || text.length % 2 || !HEX_DATA.test(text)) {
          throw new ProtocolError("LOG_DATA contains malformed hexadecimal bytes");
        }
        const chunk = Uint8Array.from(
          text.match(/../g),
          (pair) => Number.parseInt(pair, 16),
        );
        received += chunk.byteLength;
        if (received > expectedSize) {
          throw new ProtocolError("download contains more bytes than announced");
        }
        chunks.push(chunk);
        continue;
      }

      if (line.startsWith("LOG_DATA_END")) {
        const message = asLogMessage(line);
        if (message.name !== "LOG_DATA_END") {
          throw new ProtocolError(`expected LOG_DATA_END, found ${message.name}`);
        }
        const responseId = unsigned(message, "id", UINT32_MAX);
        if (responseId !== id) throw new ProtocolError("download ended for the wrong session id");
        if (received !== expectedSize) {
          throw new ProtocolError(
            `download size mismatch: received ${received}, expected ${expectedSize}`,
          );
        }
        const bytes = new Uint8Array(expectedSize);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const actualCrc = crcText(bytes);
        if (actualCrc !== expectedCrc) {
          throw new ProtocolError(`download CRC mismatch: ${actualCrc} != ${expectedCrc}`);
        }
        return new VerifiedLogDownload(ISSUE, {
          owner: this,
          sessionId: id,
          crc32: actualCrc,
          bytes,
        });
      }

      if (line.startsWith("LOG_")) {
        throw new ProtocolError(`unexpected message during download: ${line}`);
      }
      // Runtime logger events may be interleaved with download lines.
    }
  }

  async _readSingleLogMessage(expectedName, command) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const record = await this._readRecordWithin(deadline, this.timeoutMs, command);
      if (record.error) {
        if (record.linePrefix?.startsWith("LOG_")) throw record.error;
        continue;
      }
      const line = record.line;
      if (!line || line.startsWith("TELEM ")) continue;
      throwIfLogError(line);
      let message;
      try {
        message = asLogMessage(line);
      } catch (error) {
        if (line.startsWith("LOG_")) throw error;
        continue;
      }
      if (message.name === expectedName) return message;
      if (message.name.startsWith("LOG_")) {
        throw new ProtocolError(`unexpected log response: ${message.name}`);
      }
    }
    throw new ProtocolTimeoutError(`timed out waiting for response to ${JSON.stringify(command)}`);
  }

  async _readRecordWithin(deadline, inactivityTimeoutMs, command) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ProtocolTimeoutError(`timed out waiting for response to ${JSON.stringify(command)}`);
    }
    try {
      return await this.transport.readRecord(Math.max(1, Math.min(remaining, inactivityTimeoutMs)));
    } catch (error) {
      if (error instanceof ProtocolTimeoutError) {
        throw new ProtocolTimeoutError(`timed out waiting for response to ${JSON.stringify(command)}`);
      }
      throw error;
    }
  }
}
