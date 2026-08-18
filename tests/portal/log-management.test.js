import assert from "node:assert/strict";
import test from "node:test";

import {
  DeletionOutcomeUncertainError,
  LogDeviceError,
  LogManager,
  PreservationError,
  VerifiedLogDownload,
  crc32,
  inspectContinuationCatalog,
  parseLogList,
  parseLogStatus,
} from "../../portal/js/log-management.js";
import { ProtocolError } from "../../portal/js/protocol.js";
import {
  ProtocolTimeoutError,
  WebSerialTransport,
} from "../../portal/js/serial-transport.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function statusLine(overrides = {}) {
  const fields = {
    fs: 1,
    active: 0,
    id: 0,
    total: 1441792,
    used: 32768,
    free: 1409024,
    boot: 42,
    reset: 1,
    sensors: 8,
    chip_centi_c: 2460,
    rtc_source: 1,
    rtc_hz: 32768,
    interrupted: 0,
    continuation_pending: 0,
    coredump: 0,
    coredump_bytes: 0,
    retention: "rolling",
    reserve_ok: 1,
    reserve_required: 131072,
    retention_deleted_runs: 2,
    retention_deleted_segments: 3,
    retention_last_run: 7,
    retention_last_segment: 8,
    retention_pending: 0,
    retention_pending_root: 0,
    retention_highest_session: 10,
    retention_catalog_overflow: 0,
    retention_catalog_invalid: 0,
    retention_audit_ok: 1,
    retention_last_refusal: "none",
    protocol: 1,
    config_state: "valid",
    config_generation: 4,
    active_generation: 4,
    geometry: "column8_20cm_v1",
    discovered: 8,
    mapped_valid: 8,
    commissioning: 0,
    restart_required: 0,
    valid_slots: 2,
    ...overrides,
  };
  return `LOG_STATUS ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`;
}

function sessionLine(id, overrides = {}) {
  const fields = {
    id,
    bytes: 128,
    state: "finalized",
    reason: 1,
    version: 2,
    boot: 42,
    reset: 1,
    continuation_of: 0,
    continuation_kind: 0,
    ...overrides,
  };
  return `LOG_SESSION ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`;
}

function framed(...lines) {
  return `${lines.flat().join("\r\n")}\r\n`;
}

function splitText(text, sizes = [1, 7, 3, 29, 2, 113]) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const size = sizes[index % sizes.length];
    chunks.push(text.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

function downloadLines(id, bytes, overrides = {}) {
  const checksum = crc32(bytes).toString(16).toUpperCase().padStart(8, "0");
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const midpoint = Math.max(2, Math.floor(hex.length / 4) * 2);
  return [
    `LOG_DATA_BEGIN id=${overrides.beginId ?? id} bytes=${overrides.size ?? bytes.length} crc32=${overrides.crc32 ?? checksum}`,
    `LOG_DATA ${hex.slice(0, midpoint)}`,
    "TELEM sample=19 p1=80.00",
    "logger_event=diagnostic",
    `LOG_DATA ${hex.slice(midpoint)}`,
    `LOG_DATA_END id=${overrides.endId ?? id}`,
  ];
}

class ScriptedPort {
  constructor(responses) {
    this.responses = responses;
    this.commands = [];
    this._input = "";
    this._controller = null;
  }

  async open() {
    this.readable = new ReadableStream({
      start: (controller) => { this._controller = controller; },
      cancel: () => { this._controller = null; },
    });
    this.writable = new WritableStream({
      write: (chunk) => {
        this._input += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = this._input.indexOf("\n")) >= 0) {
          const command = this._input.slice(0, newline);
          this._input = this._input.slice(newline + 1);
          this.commands.push(command);
          const scripted = this.responses.get(command);
          const values = typeof scripted === "function" ? scripted(this) : scripted;
          for (const value of values ?? []) {
            this._controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
          }
        }
      },
    });
  }

  async close() {
    this._controller = null;
  }
}

class MemoryFileHandle {
  constructor(name = "session-1.slog") {
    this.name = name;
    this.saved = new Uint8Array();
  }

  async createWritable() {
    let pending = null;
    return {
      write: async (bytes) => { pending = new Uint8Array(bytes); },
      close: async () => { this.saved = pending.slice(); },
      abort: async () => { pending = null; },
    };
  }

  async getFile() {
    const snapshot = this.saved.slice();
    return { arrayBuffer: async () => snapshot.buffer };
  }
}

async function openManager(responses, options = {}, onTraffic = null) {
  const port = new ScriptedPort(responses);
  const transport = new WebSerialTransport(port, { onTraffic });
  await transport.open();
  const manager = new LogManager(transport, {
    timeoutMs: 100,
    listInactivityTimeoutMs: 100,
    listOverallTimeoutMs: 1000,
    downloadInactivityTimeoutMs: 100,
    downloadMinimumOverallTimeoutMs: 100,
    downloadMaximumOverallTimeoutMs: 1000,
    ...options,
  });
  return { manager, port, transport };
}

test("CRC32 matches the firmware/zlib representation", () => {
  assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
});

test("status parser accepts the >512-byte management line and exposes retention state", () => {
  const line = statusLine();
  assert.ok(line.length > 512, `fixture unexpectedly has only ${line.length} bytes`);
  const status = parseLogStatus(line);
  assert.deepEqual(
    {
      filesystemReady: status.filesystemReady,
      freeBytes: status.freeBytes,
      continuationPendingSessionId: status.continuationPendingSessionId,
      commissioning: status.commissioning,
      restartRequired: status.restartRequired,
      deletedRuns: status.retention.deletedRuns,
      reserveOk: status.retention.reserveOk,
    },
    {
      filesystemReady: true,
      freeBytes: 1409024,
      continuationPendingSessionId: 0,
      commissioning: false,
      restartRequired: false,
      deletedRuns: 2,
      reserveOk: true,
    },
  );
  assert.ok(Object.isFrozen(status));
  assert.ok(Object.isFrozen(status.retention));
  assert.throws(
    () => parseLogStatus(statusLine({ used: 10, free: 10 })),
    /inconsistent/,
  );
  assert.throws(
    () => parseLogStatus(statusLine({ protocol: 2 })),
    /unsupported log protocol/,
  );
});

test("list parser preserves malformed relationship metadata for read-only recovery", () => {
  const sessions = parseLogList([
    "LOG_LIST_BEGIN",
    sessionLine(1),
    sessionLine(2, { continuation_of: 1, continuation_kind: 1 }),
    "LOG_LIST_END",
  ]);
  assert.deepEqual(sessions.map(({ id, continuationOf, continuationKind }) => ({
    id,
    continuationOf,
    continuationKind,
  })), [
    { id: 1, continuationOf: 0, continuationKind: 0 },
    { id: 2, continuationOf: 1, continuationKind: 1 },
  ]);
  assert.deepEqual(
    inspectContinuationCatalog(sessions).runs.map((run) => run.map(({ id }) => id)),
    [[1, 2]],
  );
  const anchored = parseLogList([
    "LOG_LIST_BEGIN",
    sessionLine(1),
    sessionLine(2, { continuation_of: 1, continuation_kind: 3 }),
    "LOG_LIST_END",
  ]);
  assert.equal(inspectContinuationCatalog(anchored).valid, true);
  const orphaned = parseLogList([
    "LOG_LIST_BEGIN",
    sessionLine(2, { continuation_of: 1, continuation_kind: 1 }),
    "LOG_LIST_END",
  ]);
  assert.equal(orphaned[0].id, 2, "malformed catalogs remain readable/downloadable");
  assert.deepEqual(
    inspectContinuationCatalog(orphaned).issues.map(({ code }) => code),
    ["missing_predecessor"],
  );

  const unsafe = parseLogList([
    "LOG_LIST_BEGIN",
    sessionLine(1, {
      continuation_of: 2,
      continuation_kind: 9,
      reason: 0,
      version: 3,
    }),
    sessionLine(2, { state: "interrupted", reason: 2 }),
    "LOG_LIST_END",
  ]);
  const issueCodes = inspectContinuationCatalog(unsafe).issues.map(({ code }) => code);
  assert.ok(issueCodes.includes("non_monotonic_continuation"));
  assert.ok(issueCodes.includes("unsupported_version"));
  assert.ok(issueCodes.includes("invalid_continuation_kind"));
  assert.ok(issueCodes.includes("invalid_finish_reason"));
  assert.ok(issueCodes.includes("interrupted_finish_reason"));

  const partlyMalformed = parseLogList([
    "LOG_LIST_BEGIN",
    sessionLine(4),
    sessionLine(0),
    "LOG_SESSION id=broken",
    sessionLine(5),
    "LOG_LIST_END",
  ]);
  assert.deepEqual(partlyMalformed.map(({ id }) => id), [4, 5]);
  assert.equal(partlyMalformed.entryIssues.length, 2);
  assert.equal(inspectContinuationCatalog(partlyMalformed).valid, false);
});

test("a malformed catalog entry does not hide valid device files", async () => {
  const responses = new Map([
    ["LOG LIST", [framed(
      "LOG_LIST_BEGIN",
      sessionLine(1),
      "LOG_SESSION id=broken",
      sessionLine(2),
      "LOG_LIST_END",
    )]],
  ]);
  const { manager, transport } = await openManager(responses);
  const sessions = await manager.list();
  assert.deepEqual(sessions.map(({ id }) => id), [1, 2]);
  assert.equal(sessions.entryIssues.length, 1);
  assert.equal(inspectContinuationCatalog(sessions).valid, false);
  await transport.close();
});

test("status, list, and exact download survive arbitrary serial chunks and chatter", async () => {
  const bytes = Uint8Array.from({ length: 173 }, (_, index) => (index * 37) & 0xff);
  const traffic = [];
  const responses = new Map([
    ["LOG STATUS", splitText(framed("boot chatter", "TELEM sample=1", statusLine()))],
    ["LOG LIST", splitText(framed(
      "TELEM sample=2",
      "LOG_LIST_BEGIN",
      sessionLine(1, { bytes: bytes.length }),
      "logger_event=idle",
      "LOG_LIST_END",
    ))],
    ["LOG GET 1", splitText(framed(downloadLines(1, bytes)))],
  ]);
  const { manager, port, transport } = await openManager(
    responses,
    {},
    (entry) => traffic.push(entry),
  );

  assert.equal((await manager.status()).validSensors, 8);
  assert.equal((await manager.list())[0].bytes, bytes.length);
  const download = await manager.download(1);
  assert.ok(download instanceof VerifiedLogDownload);
  assert.equal(download.sessionId, 1);
  assert.equal(download.size, bytes.length);
  assert.deepEqual(download.bytes(), bytes);
  const mutableCopy = download.bytes();
  mutableCopy[0] ^= 0xff;
  assert.deepEqual(download.bytes(), bytes, "callers only receive defensive copies");
  assert.deepEqual(port.commands, ["LOG STATUS", "LOG LIST", "LOG STATUS", "LOG GET 1"]);

  const payloadTraffic = traffic.filter((entry) => entry.line.startsWith("LOG_DATA "));
  assert.ok(payloadTraffic.length >= 2);
  assert.ok(payloadTraffic.every((entry) => entry.line === "LOG_DATA payload=redacted"));
  assert.ok(traffic.every((entry) => !entry.line.includes("00254a6f")));
  await transport.close();
});

test("download fails closed on active logging, wrong size, CRC, ids, and malformed hex", async (t) => {
  await t.test("active", async () => {
    const responses = new Map([["LOG STATUS", [framed(statusLine({ active: 1, id: 9 }))]]]);
    const { manager, port, transport } = await openManager(responses);
    await assert.rejects(manager.download(1), (error) => {
      assert.ok(error instanceof LogDeviceError);
      assert.equal(error.code, "active_session");
      return true;
    });
    assert.deepEqual(port.commands, ["LOG STATUS"]);
    await transport.close();
  });

  const bytes = Uint8Array.of(1, 2, 3, 4);
  const cases = [
    ["size", downloadLines(1, bytes, { size: 5 }), /size mismatch/],
    ["crc", downloadLines(1, bytes, { crc32: "00000000" }), /CRC mismatch/],
    ["begin id", downloadLines(1, bytes, { beginId: 2 }), /wrong session id/],
    ["end id", downloadLines(1, bytes, { endId: 2 }), /wrong session id/],
    ["hex", [
      "LOG_DATA_BEGIN id=1 bytes=4 crc32=B63CFBCD",
      "LOG_DATA 0102zz04",
      "LOG_DATA_END id=1",
    ], /malformed hexadecimal/],
    ["bound", [
      "LOG_DATA_BEGIN id=1 bytes=131073 crc32=B63CFBCD",
    ], /outside the allowed bound/],
  ];
  for (const [name, lines, expected] of cases) {
    await t.test(name, async () => {
      const responses = new Map([
        ["LOG STATUS", [framed(statusLine())]],
        ["LOG GET 1", [framed(lines)]],
      ]);
      const { manager, transport } = await openManager(responses);
      await assert.rejects(manager.download(1), expected);
      await transport.close();
    });
  }
});

test("status and stalled downloads use bounded timeouts", async (t) => {
  await t.test("status", async () => {
    const { manager, transport } = await openManager(new Map(), { timeoutMs: 10 });
    await assert.rejects(manager.status(), ProtocolTimeoutError);
    await transport.close();
  });
  await t.test("download inactivity", async () => {
    const responses = new Map([
      ["LOG STATUS", [framed(statusLine())]],
      ["LOG GET 1", [framed("LOG_DATA_BEGIN id=1 bytes=4 crc32=B63CFBCD")]],
    ]);
    const { manager, transport } = await openManager(responses, {
      downloadInactivityTimeoutMs: 10,
    });
    await assert.rejects(manager.download(1), ProtocolTimeoutError);
    await transport.close();
  });
});

test("large slow catalogs use a separate bounded overall and inactivity timeout", async () => {
  const lines = [
    "LOG_LIST_BEGIN",
    ...Array.from({ length: 512 }, (_, index) => sessionLine(index + 1)),
    "LOG_LIST_END",
  ];
  const observedTimeouts = [];
  let index = 0;
  const transport = {
    async writeLine(command) {
      assert.equal(command, "LOG LIST");
    },
    async readRecord(timeoutMs) {
      observedTimeouts.push(timeoutMs);
      // Model a catalog that makes steady progress but takes much longer than
      // an ordinary one-shot command timeout overall.
      if (index % 16 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return { line: lines[index++] };
    },
  };
  const manager = new LogManager(transport, {
    timeoutMs: 1,
    listInactivityTimeoutMs: 20,
    listOverallTimeoutMs: 1000,
    downloadMinimumOverallTimeoutMs: 100,
    downloadMaximumOverallTimeoutMs: 1000,
  });
  const sessions = await manager.list();
  assert.equal(sessions.length, 512);
  assert.ok(observedTimeouts.every((value) => value > 1 && value <= 20));
});

test("list timeout constructor bounds and stalled frames fail closed", async () => {
  const minimalTransport = { async writeLine() {}, async readRecord() {} };
  assert.throws(
    () => new LogManager(minimalTransport, { listInactivityTimeoutMs: 0 }),
    /listInactivityTimeoutMs must be positive/,
  );
  assert.throws(
    () => new LogManager(minimalTransport, {
      listInactivityTimeoutMs: 101,
      listOverallTimeoutMs: 100,
    }),
    /list inactivity timeout exceeds overall timeout/,
  );

  const responses = new Map([["LOG LIST", [framed("LOG_LIST_BEGIN")]]]);
  const { manager, transport } = await openManager(responses, {
    listInactivityTimeoutMs: 10,
    listOverallTimeoutMs: 100,
  });
  await assert.rejects(manager.list(), ProtocolTimeoutError);
  await transport.close();
});

test("only exact read-back preservation issues a same-flow deletion receipt", async () => {
  const bytes = Uint8Array.from({ length: 80 }, (_, index) => index ^ 0x5a);
  const responses = new Map([
    ["LOG STATUS", [framed(statusLine())]],
    ["LOG LIST", [framed(
      "LOG_LIST_BEGIN",
      sessionLine(1, { bytes: bytes.length }),
      "LOG_LIST_END",
    )]],
    ["LOG GET 1", [framed(downloadLines(1, bytes))]],
    ["LOG DELETE 1", [framed("LOG_DELETE id=1 ok=1")]],
  ]);
  const { manager, port, transport } = await openManager(responses);
  const verified = await manager.download(1);

  await assert.rejects(manager.deletePreserved(verified), PreservationError);
  await assert.rejects(manager.deletePreserved(1), PreservationError);
  assert.throws(() => new VerifiedLogDownload(null, {}), /issued by LogManager/);

  const file = new MemoryFileHandle();
  const receipt = await manager.preserveToFile(verified, file);
  assert.deepEqual(file.saved, bytes);
  assert.equal(receipt.used, false);
  assert.equal(receipt.filename, "session-1.slog");
  assert.deepEqual(await manager.deletePreserved(receipt), { sessionId: 1 });
  assert.equal(receipt.used, true);
  assert.deepEqual(port.commands, [
    "LOG STATUS",
    "LOG GET 1",
    "LOG STATUS",
    "LOG LIST",
    "LOG GET 1",
    "LOG DELETE 1",
  ]);
  await assert.rejects(manager.deletePreserved(receipt), /already been used/);

  const corruptingFile = new MemoryFileHandle("corrupt.slog");
  const originalGetFile = corruptingFile.getFile.bind(corruptingFile);
  corruptingFile.getFile = async () => {
    const fileSnapshot = await originalGetFile();
    const content = new Uint8Array(await fileSnapshot.arrayBuffer());
    content[0] ^= 0xff;
    return { arrayBuffer: async () => content.buffer };
  };
  await assert.rejects(
    manager.preserveToFile(verified, corruptingFile),
    /does not match/,
  );

  const other = await openManager(new Map());
  await assert.rejects(other.manager.deletePreserved(receipt), /this browser flow/);
  await other.transport.close();
  await transport.close();
});

test("explicit download override revalidates the same bytes before deletion", async () => {
  const bytes = Uint8Array.of(4, 2, 4, 2, 1, 7);
  const responses = new Map([
    ["LOG STATUS", [framed(statusLine())]],
    ["LOG LIST", [framed(
      "LOG_LIST_BEGIN",
      sessionLine(1, { bytes: bytes.length }),
      "LOG_LIST_END",
    )]],
    ["LOG GET 1", [framed(downloadLines(1, bytes))]],
    ["LOG DELETE 1", [framed("LOG_DELETE id=1 ok=1")]],
  ]);
  const { manager, port, transport } = await openManager(responses);
  const download = await manager.download(1);
  assert.deepEqual(await manager.deleteDownloaded(download), { sessionId: 1 });
  assert.deepEqual(port.commands, [
    "LOG STATUS",
    "LOG GET 1",
    "LOG STATUS",
    "LOG LIST",
    "LOG GET 1",
    "LOG DELETE 1",
  ]);

  const other = await openManager(new Map());
  await assert.rejects(other.manager.deleteDownloaded(download), /this browser flow/);
  await other.transport.close();
  await transport.close();
});

test("download override rejects changed device bytes before LOG DELETE", async () => {
  const original = Uint8Array.of(1, 3, 3, 7);
  const changed = Uint8Array.of(1, 3, 3, 8);
  let gets = 0;
  const responses = new Map([
    ["LOG STATUS", [framed(statusLine())]],
    ["LOG LIST", [framed(
      "LOG_LIST_BEGIN",
      sessionLine(1, { bytes: original.length }),
      "LOG_LIST_END",
    )]],
    ["LOG GET 1", () => [framed(downloadLines(1, gets++ ? changed : original))]],
  ]);
  const { manager, port, transport } = await openManager(responses);
  await assert.rejects(
    manager.deleteDownloaded(await manager.download(1)),
    /no longer matches/,
  );
  assert.ok(!port.commands.includes("LOG DELETE 1"));
  await transport.close();
});

test("archive or device byte changes prevent deletion without sending LOG DELETE", async (t) => {
  const original = Uint8Array.of(10, 20, 30, 40, 50);

  await t.test("archive changed", async () => {
    const responses = new Map([
      ["LOG STATUS", [framed(statusLine())]],
      ["LOG GET 1", [framed(downloadLines(1, original))]],
    ]);
    const { manager, port, transport } = await openManager(responses);
    const file = new MemoryFileHandle();
    const receipt = await manager.preserveToFile(await manager.download(1), file);
    file.saved[0] ^= 0xff;
    await assert.rejects(manager.deletePreserved(receipt), /changed after verification/);
    assert.ok(!port.commands.includes("LOG DELETE 1"));
    assert.equal(receipt.used, false);
    await transport.close();
  });

  await t.test("device changed", async () => {
    let gets = 0;
    const changed = Uint8Array.of(10, 20, 30, 40, 51);
    const responses = new Map([
      ["LOG STATUS", [framed(statusLine())]],
      ["LOG LIST", [framed(
        "LOG_LIST_BEGIN",
        sessionLine(1, { bytes: original.length }),
        "LOG_LIST_END",
      )]],
      ["LOG GET 1", () => [framed(downloadLines(1, gets++ ? changed : original))]],
    ]);
    const { manager, port, transport } = await openManager(responses);
    const receipt = await manager.preserveToFile(
      await manager.download(1),
      new MemoryFileHandle(),
    );
    await assert.rejects(manager.deletePreserved(receipt), /no longer matches/);
    assert.ok(!port.commands.includes("LOG DELETE 1"));
    assert.equal(receipt.used, false);
    await transport.close();
  });
});

test("delete blocks unresolved state, pending runs, descendants, and ok=0", async (t) => {
  const bytes = Uint8Array.of(8, 6, 7, 5, 3, 0, 9);

  async function preparedManager({ status = statusLine(), sessions = [
    sessionLine(1, { bytes: bytes.length }),
  ], deleteAck = "LOG_DELETE id=1 ok=1" } = {}) {
    const responses = new Map([
      ["LOG STATUS", [framed(status)]],
      ["LOG LIST", [framed("LOG_LIST_BEGIN", sessions, "LOG_LIST_END")]],
      ["LOG GET 1", [framed(downloadLines(1, bytes))]],
      ["LOG DELETE 1", [framed(deleteAck)]],
    ]);
    const opened = await openManager(responses);
    const receipt = await opened.manager.preserveToFile(
      await opened.manager.download(1),
      new MemoryFileHandle(),
    );
    return { ...opened, receipt };
  }

  for (const [name, overrides, code] of [
    ["commissioning", { commissioning: 1 }, "configuration_unresolved"],
    ["restart", { restart_required: 1 }, "configuration_unresolved"],
    ["active", { active: 1, id: 99 }, "active_session"],
    ["retention audit", { retention_audit_ok: 0 }, "retention_audit_unavailable"],
    ["retention catalog", { retention_catalog_invalid: 1 }, "retention_catalog_invalid"],
    ["retention overflow", { retention_catalog_overflow: 1 }, "retention_catalog_invalid"],
    ["retention pending", {
      retention_pending: 1,
      retention_pending_root: 1,
    }, "retention_pending"],
  ]) {
    await t.test(name, async () => {
      const opened = await preparedManager();
      opened.port.responses.set("LOG STATUS", [framed(statusLine(overrides))]);
      await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
        assert.equal(error.code, code);
        return true;
      });
      assert.ok(!opened.port.commands.includes("LOG DELETE 1"));
      await opened.transport.close();
    });
  }

  await t.test("old firmware has no continuation safety field", async () => {
    const old = statusLine().replace(" continuation_pending=0", "");
    const opened = await preparedManager();
    opened.port.responses.set("LOG STATUS", [framed(old)]);
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.equal(error.code, "firmware_update_required");
      return true;
    });
    await opened.transport.close();
  });

  await t.test("pending continuation run", async () => {
    const opened = await preparedManager({ status: statusLine({ continuation_pending: 1 }) });
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.equal(error.code, "probable_continuation");
      return true;
    });
    assert.ok(!opened.port.commands.includes("LOG DELETE 1"));
    await opened.transport.close();
  });

  await t.test("newer continuation exists", async () => {
    const opened = await preparedManager({ sessions: [
      sessionLine(1, { bytes: bytes.length }),
      sessionLine(2, { continuation_of: 1, continuation_kind: 1 }),
    ] });
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.equal(error.code, "continuation_exists");
      return true;
    });
    await opened.transport.close();
  });

  await t.test("malformed catalog remains readable but cannot be deleted", async () => {
    const opened = await preparedManager({ sessions: [
      sessionLine(1, { bytes: bytes.length, continuation_of: 99 }),
    ] });
    assert.equal((await opened.manager.list())[0].continuationOf, 99);
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.equal(error.code, "catalog_invalid");
      return true;
    });
    assert.ok(!opened.port.commands.includes("LOG DELETE 1"));
    await opened.transport.close();
  });

  await t.test("LOG DELETE ok=0", async () => {
    const opened = await preparedManager({ deleteAck: "LOG_DELETE id=1 ok=0" });
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.equal(error.code, "delete_failed");
      return true;
    });
    assert.equal(opened.receipt.used, false);
    assert.equal(opened.port.commands.at(-1), "LOG DELETE 1");
    await opened.transport.close();
  });

  await t.test("valid LOG_ERROR is a definite refusal", async () => {
    const opened = await preparedManager();
    opened.port.responses.set("LOG DELETE 1", [framed("LOG_ERROR delete_refused")]);
    await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
      assert.ok(error instanceof LogDeviceError);
      assert.ok(!(error instanceof DeletionOutcomeUncertainError));
      assert.equal(error.code, "delete_refused");
      return true;
    });
    assert.equal(opened.receipt.used, false);
    await opened.transport.close();
  });
});

test("missing or untrustworthy delete acknowledgements report an uncertain outcome", async (t) => {
  const bytes = Uint8Array.of(2, 7, 1, 8, 2, 8);

  async function prepared(deleteResponse) {
    const responses = new Map([
      ["LOG STATUS", [framed(statusLine())]],
      ["LOG LIST", [framed(
        "LOG_LIST_BEGIN",
        sessionLine(1, { bytes: bytes.length }),
        "LOG_LIST_END",
      )]],
      ["LOG GET 1", [framed(downloadLines(1, bytes))]],
      ["LOG DELETE 1", deleteResponse],
    ]);
    const opened = await openManager(responses);
    const receipt = await opened.manager.preserveToFile(
      await opened.manager.download(1),
      new MemoryFileHandle(),
    );
    opened.manager.timeoutMs = 10;
    return { ...opened, receipt };
  }

  for (const [name, response] of [
    ["timeout", []],
    ["transport write failure", () => { throw new Error("USB write failed"); }],
    ["malformed ack", [framed("LOG_DELETE id=1 ok=maybe")]],
    ["wrong session ack", [framed("LOG_DELETE id=2 ok=1")]],
    ["unexpected ack", [framed("LOG_STATUS fs=1")]],
  ]) {
    await t.test(name, async () => {
      const opened = await prepared(response);
      await assert.rejects(opened.manager.deletePreserved(opened.receipt), (error) => {
        assert.ok(error instanceof DeletionOutcomeUncertainError);
        assert.equal(error.name, "DeletionOutcomeUncertainError");
        assert.equal(error.sessionId, 1);
        assert.ok(error.cause instanceof Error);
        return true;
      });
      assert.equal(opened.receipt.used, false);
      assert.equal(opened.port.commands.at(-1), "LOG DELETE 1");
      await opened.transport.close();
    });
  }
});
