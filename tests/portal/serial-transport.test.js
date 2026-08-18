import assert from "node:assert/strict";
import test from "node:test";

import { DeviceError, ProtocolError } from "../../portal/js/protocol.js";
import {
  AsciiLineDecoder,
  CommissioningProtocolClient,
  ProtocolTimeoutError,
  SerialTransportError,
  WebSerialTransport,
  serialPortOpenErrorMessage,
} from "../../portal/js/serial-transport.js";
import { ROMS, configurationLines, infoLine, scanLines } from "./fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ScriptedPort {
  constructor(responses = new Map()) {
    this.responses = responses;
    this.commands = [];
    this.openCalls = [];
    this.closeCalls = 0;
    this._input = "";
    this._controller = null;
  }

  async open(options) {
    this.openCalls.push(options);
    this.readable = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this._controller = null;
      },
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
          const chunks = typeof scripted === "function" ? scripted(this) : scripted;
          for (const value of chunks ?? []) this.enqueue(value);
        }
      },
    });
  }

  enqueue(value) {
    this._controller?.enqueue(typeof value === "string" ? encoder.encode(value) : value);
  }

  disconnect(partial = "") {
    if (partial) this.enqueue(partial);
    this._controller?.close();
    this._controller = null;
  }

  async close() {
    this.closeCalls += 1;
    this._controller = null;
  }
}

function lines(...values) {
  return `${values.flat().join("\r\n")}\r\n`;
}

test("serial open failures explain exclusive access and retain browser detail", () => {
  const browserError = new Error("Failed to open serial port.");
  browserError.name = "NetworkError";
  const wrapped = new SerialTransportError("could not open the serial port", {
    cause: browserError,
  });

  const message = serialPortOpenErrorMessage(wrapped);
  assert.match(message, /Close other portal tabs \(including localhost\)/);
  assert.match(message, /PlatformIO/);
  assert.match(message, /NetworkError — Failed to open serial port/);
  assert.equal(
    serialPortOpenErrorMessage(new SerialTransportError("serial port disconnected")),
    null,
  );
});

test("serial open guidance recognizes a flasher error chain", () => {
  const browserError = new Error("Failed to open the serial port");
  browserError.name = "InvalidStateError";
  const adapterError = new Error("Failed to open the serial port", {
    cause: browserError,
  });
  const workflowError = new Error("Failed to open the serial port", {
    cause: adapterError,
  });

  assert.match(
    serialPortOpenErrorMessage(workflowError, "bootloader device"),
    /selected bootloader device/,
  );
});

test("ASCII line decoder handles arbitrary chunks, CRLF, and malformed records", () => {
  const decoderUnderTest = new AsciiLineDecoder(8);
  assert.deepEqual(decoderUnderTest.push(encoder.encode("SYS_")), []);
  assert.equal(decoderUnderTest.push(encoder.encode("INFO\r\n"))[0].line, "SYS_INFO");

  const records = decoderUnderTest.push(encoder.encode("one\ntwo\n"));
  assert.deepEqual(records.map((record) => record.line), ["one", "two"]);
  assert.ok(decoderUnderTest.push(Uint8Array.of(0xff, 0x0a))[0].error instanceof ProtocolError);
  assert.match(
    decoderUnderTest.push(encoder.encode("123456789\n"))[0].error.message,
    /too long/,
  );
});

test("Web Serial transport streams split response frames into the protocol client", async () => {
  const scan = scanLines(ROMS.slice(0, 1));
  const port = new ScriptedPort(
    new Map([
      ["SYS INFO", ["boot chatter\r\nSYS_", `${infoLine().slice(4)}\r\n`]],
      [
        "CFG SCAN",
        [
          `TELEM sample=1\r\n${scan[0]}\r`,
          `\nlogger_event=storage_low\r\n${scan[1].slice(0, 24)}`,
          `${scan[1].slice(24)}\r\n${scan[2]}\r\n`,
        ],
      ],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  assert.equal((await client.info()).product, "sauna_logger");
  assert.equal((await client.scan()).probes[0].rom, ROMS[0]);
  assert.deepEqual(port.commands, ["SYS INFO", "CFG SCAN"]);
  await transport.close();
  assert.deepEqual(port.openCalls, [{ baudRate: 115200 }]);
});

test("client discards a joined response and retries only SYS INFO", async () => {
  let attempt = 0;
  const port = new ScriptedPort(
    new Map([
      ["SYS INFO", () => {
        attempt += 1;
        return attempt === 1
          ? ["TELEM sample=6 p1=18.81SYS_", `${infoLine().slice(4)}\r\n`]
          : [lines(infoLine())];
      }],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  assert.equal((await client.info()).product, "sauna_logger");
  assert.deepEqual(port.commands, ["SYS INFO", "SYS INFO"]);
  await transport.close();
});

test("unknown chatter is never split into a response and both attempts stay bounded", async () => {
  const port = new ScriptedPort(
    new Map([["SYS INFO", [`untrusted=${infoLine()}\r\n`]]]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 20 });
  await assert.rejects(client.info(), ProtocolTimeoutError);
  assert.deepEqual(port.commands, ["SYS INFO", "SYS INFO"]);
  await transport.close();
});

test("repeated malformed or ambiguous joined responses fail closed", async () => {
  const malformedPort = new ScriptedPort(
    new Map([["SYS INFO", ["TELEM sample=6SYS_INFO protocol=not-a-number\r\n"]]]),
  );
  const malformedTransport = new WebSerialTransport(malformedPort);
  await malformedTransport.open();
  await assert.rejects(
    new CommissioningProtocolClient(malformedTransport, { timeoutMs: 20 }).info(),
    ProtocolError,
  );
  assert.deepEqual(malformedPort.commands, ["SYS INFO", "SYS INFO"]);
  await malformedTransport.close();

  const ambiguousPort = new ScriptedPort(
    new Map([
      ["SYS INFO", [`TELEM sample=6SYS_INFO protocol=1 ${infoLine()}\r\n`]],
    ]),
  );
  const ambiguousTransport = new WebSerialTransport(ambiguousPort);
  await ambiguousTransport.open();
  await assert.rejects(
    new CommissioningProtocolClient(ambiguousTransport, { timeoutMs: 20 }).info(),
    ProtocolError,
  );
  assert.deepEqual(ambiguousPort.commands, ["SYS INFO", "SYS INFO"]);
  await ambiguousTransport.close();
});

test("client drains complete and partial USB backlog before its first command", async () => {
  const observed = [];
  const port = new ScriptedPort(
    new Map([["SYS INFO", [lines(infoLine())]]]),
  );
  const transport = new WebSerialTransport(port, {
    onTraffic: (entry) => observed.push(entry),
    suppressRxUntilDrained: true,
  });
  await transport.open();
  port.enqueue("00254A6FDEADBEEF\r\nTELEM sample=4 p1=18.7");

  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  assert.equal((await client.info()).product, "sauna_logger");
  assert.deepEqual(port.commands, ["SYS INFO"]);
  assert.ok(observed.some((entry) =>
    entry.line === "startup backlog discarded records=1 partial=1"
  ));
  assert.ok(observed.every((entry) => !/00254A6F|18\.7/.test(entry.line)));
  await transport.close();
});

test("silent SYS INFO is retried once while disconnect is never retried", async () => {
  const silentPort = new ScriptedPort(new Map([["SYS INFO", []]]));
  const silentTransport = new WebSerialTransport(silentPort);
  await silentTransport.open();
  await assert.rejects(
    new CommissioningProtocolClient(silentTransport, { timeoutMs: 15 }).info(),
    ProtocolTimeoutError,
  );
  assert.deepEqual(silentPort.commands, ["SYS INFO", "SYS INFO"]);
  await silentTransport.close();

  const disconnectedPort = new ScriptedPort(
    new Map([["SYS INFO", (activePort) => {
      queueMicrotask(() => activePort.disconnect());
      return [];
    }]]),
  );
  const disconnectedTransport = new WebSerialTransport(disconnectedPort);
  await disconnectedTransport.open();
  await assert.rejects(
    new CommissioningProtocolClient(disconnectedTransport, { timeoutMs: 100 }).info(),
    SerialTransportError,
  );
  assert.deepEqual(disconnectedPort.commands, ["SYS INFO"]);
  await disconnectedTransport.close();
});

test("a timed-out mutating command is never retried", async () => {
  const command = `CFG SET position=1 rom=${ROMS[0]}`;
  const port = new ScriptedPort(new Map([[command, []]]));
  const transport = new WebSerialTransport(port);
  await transport.open();
  await assert.rejects(
    new CommissioningProtocolClient(transport, { timeoutMs: 15 }).setProbe(1, ROMS[0]),
    ProtocolTimeoutError,
  );
  assert.deepEqual(port.commands, [command]);
  await transport.close();
});

test("traffic observer receives bounded TX/RX lines without affecting protocol", async () => {
  const observed = [];
  const port = new ScriptedPort(
    new Map([["SYS INFO", [lines("boot chatter", infoLine())]]]),
  );
  const transport = new WebSerialTransport(port, {
    onTraffic: (entry) => observed.push(entry),
  });
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  assert.equal((await client.info()).product, "sauna_logger");
  const normalized = observed.map(({ direction, line, malformed }) => ({
    direction,
    line,
    malformed,
  }));
  // RX may be scheduled before the writable-stream promise settles, so the
  // observer promises completeness rather than cross-stream ordering.
  assert.deepEqual(normalized.find((entry) => entry.direction === "tx"),
    { direction: "tx", line: "SYS INFO", malformed: false },
  );
  assert.deepEqual(normalized.filter((entry) => entry.direction === "rx"), [
    { direction: "rx", line: "boot chatter", malformed: false },
    { direction: "rx", line: infoLine(), malformed: false },
  ]);
  assert.ok(observed.every((entry) => Object.isFrozen(entry)));
  await transport.close();
});

test("traffic observer exceptions are swallowed", async () => {
  const port = new ScriptedPort(
    new Map([["SYS INFO", [lines(infoLine())]]]),
  );
  const transport = new WebSerialTransport(port, {
    onTraffic: () => {
      throw new Error("diagnostic renderer failed");
    },
  });
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  assert.equal((await client.info()).protocol, 1);
  await transport.close();
});

test("traffic observer redacts log payload markers even after stale chatter", async () => {
  const observed = [];
  const port = new ScriptedPort();
  const transport = new WebSerialTransport(port, {
    onTraffic: (entry) => observed.push(entry),
  });
  await transport.open();
  port.enqueue(lines(
    "TELEM sample=8 p1=21.00LOG_DATA 00254A6F",
    "staleLOG_CRASH_DATA DEADBEEF",
  ));
  await transport.readRecord(100);
  await transport.readRecord(100);

  const received = observed.filter((entry) => entry.direction === "rx");
  assert.deepEqual(received.map((entry) => entry.line), [
    "LOG_DATA payload=redacted",
    "LOG_CRASH_DATA payload=redacted",
  ]);
  assert.doesNotMatch(JSON.stringify(received), /00254A6F|DEADBEEF/);
  await transport.close();
});

test("failed writes are not reported as transmitted lines", async () => {
  const observed = [];
  const port = {
    async open() {
      this.readable = new ReadableStream({});
      this.writable = new WritableStream({
        write() {
          throw new Error("USB write failed");
        },
      });
    },
    async close() {},
  };
  const transport = new WebSerialTransport(port, {
    onTraffic: (entry) => observed.push(entry),
  });
  await transport.open();
  await assert.rejects(
    transport.writeLine("SYS INFO"),
    SerialTransportError,
  );
  assert.deepEqual(observed, []);
  await transport.close();
});

test("client serializes concurrent commands and validates normalized acknowledgements", async () => {
  const port = new ScriptedPort(
    new Map([
      ["CFG KEEPALIVE", [lines("CFG_KEEPALIVE ok=1")]],
      ["SYS INFO", [lines(infoLine())]],
      [
        "CFG COMMIT",
        [lines("CFG_COMMIT ok=1 generation=8 crc32=0123abcd reboot_required=1")],
      ],
      ["CFG ABORT", [lines("CFG_ABORT ok=1 restart_required=0")]],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });

  const keepalive = client.keepalive();
  const info = client.info();
  await Promise.all([keepalive, info]);
  assert.deepEqual(port.commands.slice(0, 2), ["CFG KEEPALIVE", "SYS INFO"]);
  assert.deepEqual(await client.commit(), {
    generation: 8,
    crc32: "0123ABCD",
    rebootRequired: true,
  });
  assert.deepEqual(await client.abort(), { restartRequired: false });
  await transport.close();
});

test("separate protocol clients share one transport-wide transaction queue", async () => {
  const scan = scanLines(ROMS.slice(0, 1));
  const port = new ScriptedPort(
    new Map([
      ["SYS INFO", (activePort) => {
        setTimeout(() => activePort.enqueue(lines(infoLine())), 5);
        return [];
      }],
      ["CFG SCAN", [lines(...scan)]],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const firstClient = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  const secondClient = new CommissioningProtocolClient(transport, { timeoutMs: 100 });

  const info = firstClient.info();
  const discovered = secondClient.scan();
  assert.equal((await info).product, "sauna_logger");
  assert.equal((await discovered).probes[0].rom, ROMS[0]);
  assert.deepEqual(port.commands, ["SYS INFO", "CFG SCAN"]);
  await transport.close();
});

test("lost BEGIN acknowledgement triggers a serialized idempotent abort", async () => {
  const port = new ScriptedPort(
    new Map([
      ["CFG BEGIN geometry=column8_20cm_v1", []],
      ["CFG ABORT", [lines("CFG_ABORT ok=1 restart_required=0")]],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 15 });
  await assert.rejects(client.begin(), ProtocolTimeoutError);
  assert.deepEqual(port.commands, [
    "CFG BEGIN geometry=column8_20cm_v1",
    "CFG ABORT",
  ]);
  await transport.close();
});

test("device errors are terminal even before a response frame", async () => {
  const port = new ScriptedPort(
    new Map([["CFG SCAN", [lines("CFG_ERROR command=scan code=active_session")]]]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  await assert.rejects(client.scan(), (error) => {
    assert.ok(error instanceof DeviceError);
    assert.equal(error.code, "active_session");
    return true;
  });
  await transport.close();
});

test("legacy SYS INFO rejection reports incompatible firmware without timing out", async () => {
  const port = new ScriptedPort(
    new Map([["SYS INFO", [lines("LOG_ERROR unknown_command")]]]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  await assert.rejects(client.info(), (error) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, "legacy-incompatible-firmware");
    assert.match(error.message, /legacy or incompatible firmware/);
    assert.doesNotMatch(error.message, /timed out/);
    return true;
  });
  assert.deepEqual(port.commands, ["SYS INFO"]);
  await transport.close();
});

test("unexpected named data and non-ASCII inside a frame fail closed", async () => {
  const begin = scanLines(ROMS.slice(0, 1))[0];
  const cases = [
    [begin, "CFG_MAP position=1\r\n"],
    [begin, Uint8Array.from([0xff, 0x0a])],
  ];
  for (const [first, second] of cases) {
    const port = new ScriptedPort(new Map([["CFG SCAN", [lines(first), second]]]));
    const transport = new WebSerialTransport(port);
    await transport.open();
    const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
    await assert.rejects(client.scan(), ProtocolError);
    await transport.close();
  }
});

test("disconnect in the middle of a response line rejects and can be reopened cleanly", async () => {
  const port = new ScriptedPort(
    new Map([
      ["SYS INFO", (activePort) => {
        queueMicrotask(() => activePort.disconnect("SYS_IN"));
        return [];
      }],
    ]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const client = new CommissioningProtocolClient(transport, { timeoutMs: 100 });
  await assert.rejects(client.info(), SerialTransportError);
  await transport.close();

  port.responses.set("SYS INFO", [lines(infoLine())]);
  await transport.open();
  assert.equal((await client.info()).activeGeneration, 7);
  await transport.close();
  assert.equal(port.openCalls.length, 2);
});

test("full configuration frame survives the Web Serial boundary", async () => {
  const port = new ScriptedPort(
    new Map([["CFG GET", [lines(configurationLines())]]]),
  );
  const transport = new WebSerialTransport(port);
  await transport.open();
  const configuration = await new CommissioningProtocolClient(transport, {
    timeoutMs: 100,
  }).getConfiguration();
  assert.deepEqual(configuration.probes.map((probe) => probe.rom), ROMS);
  await transport.close();
});
