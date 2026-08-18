import {
  DeviceError,
  GEOMETRY_ID,
  LEGACY_INCOMPATIBLE_FIRMWARE,
  MAXIMUM_LINE_LENGTH,
  ProtocolError,
  normalizeRom,
  parseAbortAck,
  parseCommitAck,
  parseConfiguration,
  parseDeviceInfo,
  parseLine,
  parseScan,
  requireSuccessfulAck,
} from "./protocol.js";

export const DEFAULT_BAUD_RATE = 115200;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 8000;

export class SerialTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SerialTransportError";
  }
}

export class ProtocolTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolTimeoutError";
  }
}

/**
 * Incrementally frame ASCII lines from arbitrary Web Serial byte chunks.
 *
 * Malformed lines are returned as records instead of being thrown immediately;
 * the protocol client can ignore boot noise before a response but must reject
 * malformed data once a named response frame has begun.
 */
export class AsciiLineDecoder {
  constructor(maximumLineLength = MAXIMUM_LINE_LENGTH) {
    this.maximumLineLength = maximumLineLength;
    this.reset();
  }

  reset() {
    this._characters = [];
    this._malformed = null;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("serial chunk must be a Uint8Array");
    }
    const records = [];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        records.push(this._finishLine());
        continue;
      }
      if (byte > 0x7f && !this._malformed) {
        this._malformed = new ProtocolError("protocol line is not ASCII");
      }
      if (byte <= 0x7f) {
        if (this._characters.length < this.maximumLineLength) {
          this._characters.push(String.fromCharCode(byte));
        } else if (
          this._characters.length === this.maximumLineLength &&
          byte === 0x0d
        ) {
          // CR is a line terminator component, not part of the 512-byte body.
          this._characters.push("\r");
        } else if (!this._malformed) {
          this._malformed = new ProtocolError("protocol line is too long");
        }
      }
    }
    return records;
  }

  hasPartialLine() {
    return this._characters.length > 0 || this._malformed !== null;
  }

  _finishLine() {
    let line = this._characters.join("").replace(/\r+$/, "");
    const error = this._malformed;
    this.reset();
    if (error) return Object.freeze({ error, linePrefix: line });
    return Object.freeze({ line });
  }
}

export function webSerialSupported(serial = globalThis.navigator?.serial) {
  return Boolean(serial && typeof serial.requestPort === "function");
}

export async function requestSerialPort(
  options = {},
  serial = globalThis.navigator?.serial,
) {
  if (!webSerialSupported(serial)) {
    throw new SerialTransportError("Web Serial is not supported by this browser");
  }
  return serial.requestPort(options);
}

/** A small reopenable wrapper around one previously authorized SerialPort. */
export class WebSerialTransport {
  constructor(port, { baudRate = DEFAULT_BAUD_RATE, onTraffic = null } = {}) {
    if (!port || typeof port.open !== "function") {
      throw new TypeError("a Web Serial SerialPort is required");
    }
    if (onTraffic !== null && typeof onTraffic !== "function") {
      throw new TypeError("onTraffic must be a function or null");
    }
    this.port = port;
    this.baudRate = baudRate;
    this._onTraffic = onTraffic;
    this._decoder = new AsciiLineDecoder();
    this._records = [];
    this._waiters = [];
    this._reader = null;
    this._writer = null;
    this._readTask = null;
    this._opened = false;
    this._closing = false;
    this._terminalError = null;
  }

  get isOpen() {
    return this._opened && !this._terminalError;
  }

  async open() {
    if (this._opened) return;
    this._records.length = 0;
    this._terminalError = null;
    this._decoder.reset();
    try {
      await this.port.open({ baudRate: this.baudRate });
      if (!this.port.readable || !this.port.writable) {
        throw new SerialTransportError("serial port did not expose readable and writable streams");
      }
      this._reader = this.port.readable.getReader();
      this._writer = this.port.writable.getWriter();
      this._opened = true;
      this._readTask = this._readLoop();
    } catch (error) {
      this._opened = false;
      try {
        await this.port.close?.();
      } catch {
        // Preserve the original open error.
      }
      if (error instanceof SerialTransportError) throw error;
      throw new SerialTransportError("could not open the serial port", { cause: error });
    }
  }

  async writeLine(line) {
    if (!this.isOpen || !this._writer) {
      throw this._terminalError ?? new SerialTransportError("serial port is not open");
    }
    if (
      typeof line !== "string" ||
      !line ||
      line.length > MAXIMUM_LINE_LENGTH ||
      /[\r\n]/.test(line) ||
      [...line].some((character) => character.charCodeAt(0) > 0x7f)
    ) {
      throw new ProtocolError("serial command must be one non-empty ASCII line");
    }
    try {
      await this._writer.write(new TextEncoder().encode(`${line}\n`));
      this._observeTraffic({
        kind: "serial",
        direction: "tx",
        line,
        malformed: false,
      });
    } catch (error) {
      const wrapped = new SerialTransportError("could not write to the serial port", {
        cause: error,
      });
      this._fail(wrapped);
      throw wrapped;
    }
  }

  readRecord(timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS) {
    if (this._records.length) return Promise.resolve(this._records.shift());
    if (this._terminalError) return Promise.reject(this._terminalError);
    if (!this._opened) {
      return Promise.reject(new SerialTransportError("serial port is not open"));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this._waiters.indexOf(waiter);
        if (index >= 0) this._waiters.splice(index, 1);
        reject(new ProtocolTimeoutError("timed out waiting for serial data"));
      }, Math.max(0, timeoutMs));
      this._waiters.push(waiter);
    });
  }

  async close() {
    if (!this._opened && !this._reader && !this._writer) return;
    this._closing = true;
    const closingError = new SerialTransportError("serial port was closed");
    this._failWaiters(closingError);
    const reader = this._reader;
    try {
      await reader?.cancel();
    } catch {
      // A physical disconnect commonly makes cancellation reject.
    }
    try {
      await this._readTask;
    } catch {
      // The read loop reports failures through readRecord().
    }
    if (this._writer) {
      try {
        this._writer.releaseLock();
      } catch {
        // The underlying stream may already be gone.
      }
      this._writer = null;
    }
    try {
      await this.port.close();
    } catch {
      // A disconnected device is already closed from the user's perspective.
    }
    this._reader = null;
    this._readTask = null;
    this._opened = false;
    this._closing = false;
    this._terminalError = null;
    this._records.length = 0;
    this._decoder.reset();
  }

  async _readLoop() {
    const reader = this._reader;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const record of this._decoder.push(value)) {
          this._observeTraffic({
            kind: "serial",
            direction: "rx",
            line: record.error ? record.linePrefix : record.line,
            malformed: Boolean(record.error),
          });
          this._deliver(record);
        }
      }
      if (!this._closing) {
        const detail = this._decoder.hasPartialLine() ? " in the middle of a line" : "";
        this._fail(new SerialTransportError(`serial port disconnected${detail}`));
      }
    } catch (error) {
      if (!this._closing) {
        this._fail(
          new SerialTransportError("serial port disconnected while reading", {
            cause: error,
          }),
        );
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A released or errored stream needs no further cleanup.
      }
      if (this._reader === reader) this._reader = null;
    }
  }

  _deliver(record) {
    const waiter = this._waiters.shift();
    if (!waiter) {
      this._records.push(record);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(record);
  }

  _observeTraffic(entry) {
    try {
      this._onTraffic?.(Object.freeze({ ...entry }));
    } catch {
      // Read-only diagnostics must never alter serial protocol behavior.
    }
  }

  _fail(error) {
    if (!this._terminalError) this._terminalError = error;
    this._opened = false;
    this._failWaiters(this._terminalError);
  }

  _failWaiters(error) {
    for (const waiter of this._waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

/** Sequential request/response client for the SYS/CFG protocol. */
export class CommissioningProtocolClient {
  constructor(transport, { timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS } = {}) {
    if (!transport || typeof transport.writeLine !== "function") {
      throw new TypeError("a serial transport is required");
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this._tail = Promise.resolve();
  }

  info() {
    return this._enqueue(async () => {
      const response = await this._requestUnlocked("SYS INFO", "SYS_INFO", "SYS_INFO");
      return parseDeviceInfo(response[0]);
    });
  }

  scan() {
    return this._enqueue(async () =>
      parseScan(
        await this._requestUnlocked(
          "CFG SCAN",
          "CFG_SCAN_BEGIN",
          "CFG_SCAN_END",
          "CFG_SCAN_SENSOR",
        ),
      ),
    );
  }

  getConfiguration() {
    return this._enqueue(async () =>
      parseConfiguration(
        await this._requestUnlocked("CFG GET", "CFG_GET_BEGIN", "CFG_GET_END", "CFG_MAP"),
      ),
    );
  }

  begin(geometry = GEOMETRY_ID) {
    return this._enqueue(async () => {
      try {
        const response = await this._requestUnlocked(
          `CFG BEGIN geometry=${geometry}`,
          "CFG_BEGIN",
          "CFG_BEGIN",
        );
        const message = requireSuccessfulAck(response[0], "CFG_BEGIN");
        if (message.fields.geometry !== geometry) {
          throw new ProtocolError("CFG_BEGIN acknowledged the wrong geometry");
        }
      } catch (error) {
        // BEGIN may have reached the device even if its acknowledgement did
        // not. An immediate idempotent abort prevents an abandoned lock.
        try {
          const response = await this._requestUnlocked(
            "CFG ABORT",
            "CFG_ABORT",
            "CFG_ABORT",
          );
          parseAbortAck(response[0]);
        } catch {
          // The original failure remains the useful diagnosis.
        }
        throw error;
      }
    });
  }

  setProbe(position, value) {
    return this._enqueue(async () => {
      if (!Number.isInteger(position) || position < 1 || position > 8) {
        throw new ProtocolError(`invalid probe position: ${position}`);
      }
      const rom = normalizeRom(value);
      const response = await this._requestUnlocked(
        `CFG SET position=${position} rom=${rom}`,
        "CFG_SET",
        "CFG_SET",
      );
      const message = requireSuccessfulAck(response[0], "CFG_SET");
      if (Number(message.fields.position) !== position) {
        throw new ProtocolError("CFG_SET acknowledged the wrong position");
      }
      if (normalizeRom(message.fields.rom) !== rom) {
        throw new ProtocolError("CFG_SET acknowledged the wrong ROM address");
      }
    });
  }

  commit() {
    return this._enqueue(async () => {
      const response = await this._requestUnlocked(
        "CFG COMMIT",
        "CFG_COMMIT",
        "CFG_COMMIT",
      );
      const result = parseCommitAck(response[0]);
      if (!result.rebootRequired) {
        throw new ProtocolError("CFG_COMMIT did not require activation by reboot");
      }
      return result;
    });
  }

  abort() {
    return this._enqueue(async () => {
      const response = await this._requestUnlocked("CFG ABORT", "CFG_ABORT", "CFG_ABORT");
      return parseAbortAck(response[0]);
    });
  }

  keepalive() {
    return this._enqueue(async () => {
      const response = await this._requestUnlocked(
        "CFG KEEPALIVE",
        "CFG_KEEPALIVE",
        "CFG_KEEPALIVE",
      );
      requireSuccessfulAck(response[0], "CFG_KEEPALIVE");
    });
  }

  reboot() {
    return this._enqueue(async () => {
      const response = await this._requestUnlocked(
        "SYS REBOOT",
        "SYS_REBOOT",
        "SYS_REBOOT",
      );
      requireSuccessfulAck(response[0], "SYS_REBOOT");
    });
  }

  _enqueue(operation) {
    const result = this._tail.then(operation, operation);
    this._tail = result.catch(() => {});
    return result;
  }

  async _requestUnlocked(command, beginName, endName, memberName = null) {
    await this.transport.writeLine(command);
    const deadline = Date.now() + this.timeoutMs;
    let started = false;
    const response = [];
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let record;
      try {
        record = await this.transport.readRecord(remaining);
      } catch (error) {
        if (error instanceof ProtocolTimeoutError) {
          throw new ProtocolTimeoutError(`timed out waiting for response to ${JSON.stringify(command)}`);
        }
        throw error;
      }
      if (record.error) {
        if (started) throw record.error;
        continue;
      }
      const line = record.line;
      if (!line) continue;
      if (
        command === "SYS INFO" &&
        !started &&
        line.trim() === "LOG_ERROR unknown_command"
      ) {
        throw new ProtocolError(
          "the running logger rejected SYS INFO and has legacy or incompatible firmware; install the current bundled firmware before continuing",
          { code: LEGACY_INCOMPATIBLE_FIRMWARE },
        );
      }
      let message;
      try {
        message = parseLine(line);
      } catch (error) {
        if (started && /^(CFG_|SYS_)/.test(line)) throw error;
        continue;
      }
      if (message.name === "TELEM") continue;
      if (message.name === "CFG_ERROR" || message.name === "SYS_ERROR") {
        throw new DeviceError(message);
      }
      if (!started) {
        if (message.name !== beginName) continue;
        started = true;
        response.push(message);
        if (beginName === endName) return response;
        continue;
      }
      if (message.name === endName) {
        response.push(message);
        return response;
      }
      if (memberName && message.name === memberName) {
        response.push(message);
        continue;
      }
      if (/^(CFG_|SYS_)/.test(message.name)) {
        throw new ProtocolError(`unexpected response message: ${message.name}`);
      }
      // Runtime logger events may be interleaved with a response.
    }
    throw new ProtocolTimeoutError(`timed out waiting for response to ${JSON.stringify(command)}`);
  }
}
