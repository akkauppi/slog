import assert from "node:assert/strict";
import test from "node:test";

import {
  DiagnosticBuffer,
  MAXIMUM_DIAGNOSTIC_LENGTH,
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
      "Sauna logger portal diagnostics",
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
