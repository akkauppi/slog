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

export function diagnosticConsoleView(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("diagnostic console entries must be an array");
  }
  const count = entries.length;
  const latest = entries.at(-1);
  return Object.freeze({
    count,
    countLabel: `${count} ${count === 1 ? "entry" : "entries"}`,
    preview: latest
      ? `${latest.source.toUpperCase()} ${
          ["tx", "rx"].includes(latest.direction)
            ? latest.direction.toUpperCase()
            : "—"
        } · ${latest.line}`
      : "No diagnostics recorded",
  });
}

function editableTarget(target) {
  const tagName = String(target?.tagName ?? "").toLowerCase();
  return (
    target?.isContentEditable === true ||
    ["input", "select", "textarea"].includes(tagName)
  );
}

/** F2 mirrors the familiar full-console shortcut without intercepting form input. */
export function isDiagnosticConsoleToggleEvent(event) {
  return Boolean(
    event?.key === "F2" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      !editableTarget(event.target),
  );
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
    onChange = () => {},
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
    if (typeof onChange !== "function") {
      throw new TypeError("diagnostic transcript change handler must be a function");
    }
    this.list = list;
    this.status = status;
    this.context = context;
    this.onChange = onChange;
    this.buffer = new DiagnosticBuffer(capacity);
    this.#notify();
  }

  record(input, options) {
    const entry = this.buffer.record(input, options);
    if (!entry) return;
    this.#append(entry);
    while (this.list.children.length > this.buffer.capacity) {
      this.list.firstElementChild?.remove();
    }
    this.#notify();
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
    this.#notify();
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
    const distanceFromBottom =
      this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
    const shouldFollow = distanceFromBottom <= 24;
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
    // Follow live traffic until the reader intentionally scrolls back. This
    // keeps the dock useful as a console without fighting inspection of an
    // earlier failure.
    if (shouldFollow) this.list.scrollTop = this.list.scrollHeight;
  }

  #setStatus(text) {
    this.status.textContent = text;
  }

  #notify() {
    this.onChange(diagnosticConsoleView(this.buffer.entries));
  }
}

/** Controls presentation only; serial ownership remains with managed workflows. */
export class DiagnosticConsole {
  constructor({ root, panel, toggle, toggleLabel, count, preview, scrollTarget }) {
    for (const [name, value] of Object.entries({
      root,
      panel,
      toggle,
      toggleLabel,
      count,
      preview,
      scrollTarget,
    })) {
      if (!(value instanceof HTMLElement)) {
        throw new TypeError(`diagnostic console requires a ${name} element`);
      }
    }

    this.root = root;
    this.panel = panel;
    this.toggle = toggle;
    this.toggleLabel = toggleLabel;
    this.count = count;
    this.preview = preview;
    this.scrollTarget = scrollTarget;
    this.document = root.ownerDocument;
    this.handleToggle = () => this.setExpanded(!this.expanded);
    this.handleKeydown = (event) => {
      if (isDiagnosticConsoleToggleEvent(event)) {
        event.preventDefault();
        this.setExpanded(!this.expanded);
        return;
      }
      if (
        event.key === "Escape" &&
        this.expanded &&
        this.root.contains(this.document.activeElement)
      ) {
        event.preventDefault();
        this.setExpanded(false);
      }
    };

    this.toggle.addEventListener("click", this.handleToggle);
    this.document.addEventListener("keydown", this.handleKeydown);
    this.setExpanded(this.root.dataset.expanded === "true");
  }

  get expanded() {
    return this.root.dataset.expanded === "true";
  }

  setExpanded(expanded) {
    const next = Boolean(expanded);
    const restoreToggleFocus =
      !next && this.panel.contains(this.document.activeElement);
    this.root.dataset.expanded = String(next);
    this.panel.hidden = !next;
    this.toggle.setAttribute("aria-expanded", String(next));
    this.toggle.setAttribute(
      "aria-label",
      `${next ? "Collapse" : "Expand"} diagnostics console (F2)`,
    );
    this.toggleLabel.textContent = next ? "Collapse" : "Expand";
    this.document.body.classList.toggle("diagnostic-console-open", next);
    if (next) {
      requestAnimationFrame(() => {
        this.scrollTarget.scrollTop = this.scrollTarget.scrollHeight;
      });
    } else if (restoreToggleFocus) {
      this.toggle.focus({ preventScroll: true });
    }
  }

  update(view) {
    this.count.textContent = view.countLabel;
    this.preview.textContent = view.preview;
  }
}
