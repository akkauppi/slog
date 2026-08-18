import assert from "node:assert/strict";
import test from "node:test";

import {
  DiagnosticBuffer,
  DiagnosticConsole,
  MAXIMUM_DIAGNOSTIC_LENGTH,
  diagnosticConsoleView,
  isDiagnosticConsoleToggleEvent,
  sanitizeDiagnosticText,
} from "../../portal/js/diagnostics.js";

const ENTRY_TIME = new Date("2026-08-18T08:09:10.000Z");
const EXPORT_TIME = new Date("2026-08-18T08:10:11.000Z");

test("diagnostic buffer retains only the newest 300 entries", () => {
  const buffer = new DiagnosticBuffer();
  for (let index = 0; index < 305; index += 1) {
    buffer.record({ line: `entry-${index}` }, { at: ENTRY_TIME });
  }

  const entries = buffer.entries;
  assert.equal(entries.length, 300);
  assert.equal(entries[0].line, "entry-5");
  assert.equal(entries.at(-1).line, "entry-304");
  assert.ok(entries.every((entry) => Object.isFrozen(entry)));

  entries.length = 0;
  assert.equal(buffer.entries.length, 300, "callers cannot mutate retained state");
});

test("diagnostic text strips terminal escapes, makes controls visible, and truncates", () => {
  assert.equal(
    sanitizeDiagnosticText(
      "\u001b[31mred\u001b[0m\r\nnext\u0000value\u001b]0;title\u0007",
    ),
    "red ↩ next�value",
  );

  const truncated = sanitizeDiagnosticText("x".repeat(1400));
  assert.equal(truncated.length, MAXIMUM_DIAGNOSTIC_LENGTH);
  assert.match(truncated, /… \[truncated\]$/);
});

test("diagnostic export has a deterministic versioned shape and sorted context", () => {
  const buffer = new DiagnosticBuffer(3);
  buffer.record(
    { source: "serial", direction: "rx", line: "SYS_INFO protocol=1" },
    { at: ENTRY_TIME },
  );

  assert.equal(
    buffer.text(
      { usb_device: "1234:5678", protocol: 1 },
      { exportedAt: EXPORT_TIME },
    ),
    [
      "SLOG portal diagnostics",
      "format_version=1",
      "exported_at=2026-08-18T08:10:11.000Z",
      "retained_entries=1",
      "context.protocol=1",
      "context.usb_device=1234:5678",
      "",
      "2026-08-18T08:09:10.000Z [SERIAL] RX SYS_INFO protocol=1",
      "",
    ].join("\n"),
  );
});

test("clearing diagnostics removes every retained entry", () => {
  const buffer = new DiagnosticBuffer(2);
  buffer.record({ line: "first" }, { at: ENTRY_TIME });
  buffer.record({ line: "second" }, { at: ENTRY_TIME });
  buffer.clear();

  assert.deepEqual(buffer.entries, []);
  assert.match(
    buffer.text({}, { exportedAt: EXPORT_TIME }),
    /retained_entries=0\n\n$/,
  );
});

test("diagnostic console summarizes the latest bounded transcript entry", () => {
  assert.deepEqual(diagnosticConsoleView([]), {
    count: 0,
    countLabel: "0 entries",
    preview: "No diagnostics recorded",
  });

  const buffer = new DiagnosticBuffer(2);
  buffer.record(
    { source: "portal", direction: "event", line: "opened" },
    { at: ENTRY_TIME },
  );
  buffer.record(
    { source: "serial", direction: "rx", line: "SYS_INFO protocol=1" },
    { at: ENTRY_TIME },
  );
  buffer.record(
    { source: "serial", direction: "tx", line: "LOG STATUS" },
    { at: ENTRY_TIME },
  );

  assert.deepEqual(diagnosticConsoleView(buffer.entries), {
    count: 2,
    countLabel: "2 entries",
    preview: "SERIAL TX · LOG STATUS",
  });
});

test("F2 toggles the console without taking over editable controls", () => {
  assert.equal(
    isDiagnosticConsoleToggleEvent({ key: "F2", target: { tagName: "BUTTON" } }),
    true,
  );
  assert.equal(
    isDiagnosticConsoleToggleEvent({ key: "F2", target: { tagName: "INPUT" } }),
    false,
  );
  assert.equal(
    isDiagnosticConsoleToggleEvent({ key: "F2", ctrlKey: true }),
    false,
  );
  assert.equal(isDiagnosticConsoleToggleEvent({ key: "Escape" }), false);
});

test("collapsing the console never leaves focus inside its hidden panel", () => {
  const previousElement = globalThis.HTMLElement;
  const previousAnimationFrame = globalThis.requestAnimationFrame;

  class FakeElement {
    constructor(ownerDocument) {
      this.ownerDocument = ownerDocument;
      this.dataset = {};
      this.attributes = new Map();
      this.descendants = new Set();
      this.hidden = false;
      this.textContent = "";
      this.scrollHeight = 20;
      this.scrollTop = 0;
    }

    addEventListener() {}
    setAttribute(name, value) { this.attributes.set(name, value); }
    contains(value) { return value === this || this.descendants.has(value); }
    focus() { this.ownerDocument.activeElement = this; }
  }

  const documentUnderTest = {
    activeElement: null,
    addEventListener() {},
    body: { classList: { toggle() {} } },
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.requestAnimationFrame = (callback) => callback();
  try {
    const root = new FakeElement(documentUnderTest);
    root.dataset.expanded = "false";
    const panel = new FakeElement(documentUnderTest);
    const toggle = new FakeElement(documentUnderTest);
    const action = new FakeElement(documentUnderTest);
    panel.descendants.add(action);
    const consoleUnderTest = new DiagnosticConsole({
      root,
      panel,
      toggle,
      toggleLabel: new FakeElement(documentUnderTest),
      count: new FakeElement(documentUnderTest),
      preview: new FakeElement(documentUnderTest),
      scrollTarget: new FakeElement(documentUnderTest),
    });

    consoleUnderTest.setExpanded(true);
    documentUnderTest.activeElement = action;
    consoleUnderTest.setExpanded(false);
    assert.equal(panel.hidden, true);
    assert.equal(documentUnderTest.activeElement, toggle);
  } finally {
    if (previousElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousElement;
    if (previousAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});
