export const DEFAULT_DIAGNOSTIC_CAPACITY = 300;
export const MAXIMUM_DIAGNOSTIC_LENGTH = 1200;

const TRUNCATION_MARK = "… [truncated]";
const ANSI_SEQUENCE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;

/**
 * Make one diagnostic value safe to render and safe to place on one line in
 * an exported text file. This is presentation sanitization, not protocol
 * parsing; workflow controllers still validate their own input independently.
 */
export function sanitizeDiagnosticText(value) {
  const cleaned = String(value ?? "")
    .replace(ANSI_SEQUENCE, "")
    .replace(/\r\n?|\n/g, " ↩ ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "�")
    .trimEnd();
  if (cleaned.length <= MAXIMUM_DIAGNOSTIC_LENGTH) return cleaned;
  return `${cleaned.slice(
    0,
    MAXIMUM_DIAGNOSTIC_LENGTH - TRUNCATION_MARK.length,
  )}${TRUNCATION_MARK}`;
}

function normalizedLabel(value, fallback) {
  const label = sanitizeDiagnosticText(value).trim().toLowerCase();
  return label || fallback;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid date`);
  }
  return date.toISOString();
}

function textEntry(entry) {
  const direction = ["tx", "rx"].includes(entry.direction)
    ? entry.direction.toUpperCase()
    : "--";
  return `${entry.at} [${entry.source.toUpperCase()}] ${direction} ${entry.line}`;
}

/** A DOM-independent, bounded source of truth for diagnostics and exports. */
export class DiagnosticBuffer {
  #capacity;
  #entries = [];

  constructor(capacity = DEFAULT_DIAGNOSTIC_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("diagnostic transcript capacity must be positive");
    }
    this.#capacity = capacity;
  }

  get capacity() {
    return this.#capacity;
  }

  get entries() {
    return this.#entries.slice();
  }

  record(
    { source = "portal", direction = "event", line } = {},
    { at = new Date() } = {},
  ) {
    const text = sanitizeDiagnosticText(line);
    if (!text) return null;
    const entry = Object.freeze({
      at: isoTimestamp(at, "diagnostic timestamp"),
      source: normalizedLabel(source, "portal"),
      direction: normalizedLabel(direction, "event"),
      line: text,
    });
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
    return entry;
  }

  clear() {
    this.#entries.length = 0;
  }

  text(context = {}, { exportedAt = new Date() } = {}) {
    const metadata = Object.entries(context ?? {})
      .map(([key, value]) => [
        normalizedLabel(key, "field").replace(/[^a-z0-9_.-]+/g, "_"),
        sanitizeDiagnosticText(value),
      ])
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));
    const heading = [
      "Sauna logger portal diagnostics",
      "format_version=1",
      `exported_at=${isoTimestamp(exportedAt, "export timestamp")}`,
      `retained_entries=${this.#entries.length}`,
      ...metadata.map(([key, value]) => `context.${key}=${value}`),
      "",
    ];
    return `${heading.concat(this.#entries.map(textEntry)).join("\n")}\n`;
  }
}

function stampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class DiagnosticTranscript {
  constructor({
    list,
    status,
    capacity = DEFAULT_DIAGNOSTIC_CAPACITY,
    context = () => ({}),
  }) {
    if (!(list instanceof HTMLOListElement)) {
      throw new TypeError("diagnostic transcript requires an ordered list");
    }
    if (!(status instanceof HTMLElement)) {
      throw new TypeError("diagnostic transcript requires a status element");
    }
    if (typeof context !== "function") {
      throw new TypeError("diagnostic transcript context must be a function");
    }
    this.list = list;
    this.status = status;
    this.context = context;
    this.buffer = new DiagnosticBuffer(capacity);
  }

  record(input, options) {
    const entry = this.buffer.record(input, options);
    if (!entry) return;
    this.#append(entry);
    while (this.list.children.length > this.buffer.capacity) {
      this.list.firstElementChild?.remove();
    }
  }

  serialTraffic({ direction, line, malformed = false }) {
    this.record({
      source: "serial",
      direction,
      line: malformed ? `[malformed] ${line || "unreadable record"}` : line,
    });
  }

  clear() {
    this.buffer.clear();
    this.list.replaceChildren();
    this.#setStatus("Transcript cleared.");
  }

  text({ exportedAt = new Date() } = {}) {
    return this.buffer.text(this.context?.() ?? {}, { exportedAt });
  }

  async copy() {
    const value = this.text();
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      if (!copied) throw new Error("browser copy command failed");
    }
    this.#setStatus("Transcript copied.");
  }

  download() {
    const createdAt = new Date();
    const url = URL.createObjectURL(
      new Blob([this.text({ exportedAt: createdAt })], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `sauna-logger-diagnostics-${stampForFilename(createdAt)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.#setStatus("Diagnostics download created.");
  }

  reportActionError(error) {
    this.#setStatus(
      error?.message
        ? `Diagnostic action failed: ${error.message}`
        : "Diagnostic action failed.",
    );
  }

  #append(entry) {
    const item = document.createElement("li");
    item.className = "transcript-entry";
    item.dataset.direction = entry.direction;

    const time = document.createElement("time");
    time.className = "transcript-entry__time";
    time.dateTime = entry.at;
    time.textContent = new Date(entry.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const source = document.createElement("span");
    source.className = "transcript-entry__source";
    source.textContent = entry.source.toUpperCase();

    const direction = document.createElement("span");
    direction.className = "transcript-entry__direction";
    direction.textContent = entry.direction === "tx"
      ? "TX"
      : entry.direction === "rx"
        ? "RX"
        : "—";

    const line = document.createElement("span");
    line.className = "transcript-entry__text";
    line.textContent = entry.line;
    item.append(time, source, direction, line);
    this.list.append(item);
    this.list.scrollTop = this.list.scrollHeight;
  }

  #setStatus(text) {
    this.status.textContent = text;
  }
}
