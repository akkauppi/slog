import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SLOG_LIMITS,
  SlogAnalysisError,
  SlogParseError,
  analyzeRun,
  buildRun,
  groupSessionsIntoRuns,
  parseSlog,
  slogCrc32,
} from "../../portal/js/log-analysis.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function pythonReferenceFixtures() {
  const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
  const python = existsSync(localPython) ? localPython : "python";
  const script = `
import base64
import json
import sys
sys.path.insert(0, ${JSON.stringify(path.join(repositoryRoot, "tools"))})
sys.path.insert(0, ${JSON.stringify(path.join(repositoryRoot, "tests"))})
from test_logs import fixture
from logs import parse_session

def describe(session):
    return {
        "sessionId": session.session_id,
        "sampleIntervalMs": session.sample_interval_ms,
        "version": session.version,
        "bootId": session.boot_id,
        "resetReason": session.reset_reason,
        "continuationOf": session.continuation_of,
        "continuationKind": session.continuation_kind,
        "continuationDelaySeconds": session.continuation_delay_seconds,
        "initialRtcSource": session.initial_rtc_source,
        "initialRtcHz": session.initial_rtc_hz,
        "finalized": session.finalized,
        "finishReason": session.finish_reason,
        "warnings": list(session.warnings),
        "sensors": [
            {"rom": sensor.rom, "relativeHeightCm": sensor.relative_height_cm}
            for sensor in session.sensors
        ],
        "samples": [
            {
                "relativeSeconds": sample.relative_seconds,
                "temperaturesC": list(sample.temperatures_c),
                "chipTemperatureC": sample.chip_temperature_c,
                "statusFlags": sample.status_flags,
            }
            for sample in session.samples
        ],
    }

result = {}
for name, options in {
    "v1": {"version": 1},
    "v2": {"version": 2},
    "torn": {"version": 1, "torn": True},
}.items():
    data = fixture(**options)
    result[name] = {
        "base64": base64.b64encode(data).decode("ascii"),
        "parsed": describe(parse_session(data)),
    }
data = open(${JSON.stringify(
    path.join(repositoryRoot, "data", "2026-08-16-sauna", "session-1.slog"),
  )}, "rb").read()
result["real"] = {
    "base64": base64.b64encode(data).decode("ascii"),
    "parsed": describe(parse_session(data)),
}
print(json.dumps(result, separators=(",", ":")))
`;
  const result = spawnSync(python, ["-c", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `could not run canonical Python fixture/parser:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

const reference = pythonReferenceFixtures();

function fixtureBytes(name) {
  return Uint8Array.from(Buffer.from(reference[name].base64, "base64"));
}

function parserProjection(session) {
  return {
    sessionId: session.sessionId,
    sampleIntervalMs: session.sampleIntervalMs,
    version: session.version,
    bootId: session.bootId,
    resetReason: session.resetReason,
    continuationOf: session.continuationOf,
    continuationKind: session.continuationKind,
    continuationDelaySeconds: session.continuationDelaySeconds,
    initialRtcSource: session.initialRtcSource,
    initialRtcHz: session.initialRtcHz,
    finalized: session.finalized,
    finishReason: session.finishReason,
    warnings: [...session.warnings],
    sensors: session.sensors.map(({ rom, relativeHeightCm }) => ({
      rom,
      relativeHeightCm,
    })),
    samples: session.samples.map(
      ({ relativeSeconds, temperaturesC, chipTemperatureC, statusFlags }) => ({
        relativeSeconds,
        temperaturesC: [...temperaturesC],
        chipTemperatureC,
        statusFlags,
      }),
    ),
  };
}

function conservativeReference(name) {
  const expected = structuredClone(reference[name].parsed);
  if (expected.version === 1 && expected.continuationOf) {
    // Unlike the legacy Python label, v1 does not carry enough metadata to
    // prove why it continues. Do not falsely promise max-duration overlap.
    expected.continuationKind = "legacy_unspecified";
  }
  return expected;
}

function cloneSession(session, overrides = {}) {
  return { ...session, ...overrides };
}

function asRunRoot(session, overrides = {}) {
  return cloneSession(session, {
    continuationOf: 0,
    continuationKind: "none",
    continuationDelaySeconds: 0,
    ...overrides,
  });
}

test("CRC-32 matches the firmware and zlib standard vector", () => {
  assert.equal(
    slogCrc32(new TextEncoder().encode("123456789")),
    0xcbf43926,
  );
});

test("v1 and v2 binary fields match the canonical Python fixture parser", () => {
  for (const name of ["v1", "v2"]) {
    const bytes = fixtureBytes(name);
    const framed = new Uint8Array(bytes.length + 7);
    framed.set(bytes, 3);
    const inputView = framed.subarray(3, 3 + bytes.length);
    const session = parseSlog(inputView);

    assert.deepEqual(parserProjection(session), conservativeReference(name));
    assert.deepEqual(session.rawBytes, bytes);
    assert.notEqual(session.rawBytes.buffer, inputView.buffer);

    inputView[0] ^= 0xff;
    assert.equal(session.rawBytes[0], bytes[0]);
    const exposedCopy = session.rawBytes;
    exposedCopy[0] ^= 0xff;
    assert.equal(session.rawBytes[0], bytes[0]);
  }
});

test("every truncation preserves only complete CRC-valid blocks", () => {
  const complete = fixtureBytes("v2");
  const headerSize = new DataView(complete.buffer).getUint16(10, true);
  for (let cut = 0; cut <= complete.length; cut += 1) {
    if (cut < headerSize) {
      assert.throws(
        () => parseSlog(complete.subarray(0, cut)),
        SlogParseError,
        `cut ${cut} must fail closed before the header is complete`,
      );
      continue;
    }
    const session = parseSlog(complete.subarray(0, cut));
    assert.ok(session.samples.length <= 4, `cut ${cut} decoded too much`);
    if (cut < complete.length) assert.equal(session.finalized, false);
  }
});

test("a torn tail keeps the earlier committed block and exact raw source", () => {
  const bytes = fixtureBytes("torn");
  const session = parseSlog(bytes);
  assert.deepEqual(parserProjection(session), conservativeReference("torn"));
  assert.equal(session.samples.length, 4);
  assert.equal(session.finalized, false);
  assert.match(session.warnings.join("\n"), /torn/);
  assert.deepEqual(session.rawBytes, bytes);
  assert.equal(session.integrity.validBlockCount, 1);
});

test("the tracked real session is a parser golden", () => {
  const bytes = fixtureBytes("real");
  const session = parseSlog(bytes);
  assert.deepEqual(parserProjection(session), reference.real.parsed);
  assert.equal(bytes.length, 13786);
  assert.equal(session.version, 2);
  assert.equal(session.samples.length, 540);
  assert.equal(session.integrity.validBlockCount, 9);
  assert.equal(session.finalized, false);
  assert.equal(session.samples[0].relativeSeconds, -590);
  assert.equal(session.samples.at(-1).relativeSeconds, 4800);
});

test("bad headers and unbounded inputs are rejected", () => {
  const badHeader = fixtureBytes("v2");
  badHeader[20] ^= 1;
  assert.throws(
    () => parseSlog(badHeader),
    (error) =>
      error instanceof SlogParseError && error.code === "header-crc-mismatch",
  );
  assert.throws(
    () => parseSlog(new Uint8Array(SLOG_LIMITS.maximumBytes + 1)),
    (error) => error instanceof SlogParseError && error.code === "file-too-large",
  );
});

test("footer suffixes and non-monotonic CRC-valid timestamps are surfaced", () => {
  const complete = fixtureBytes("v2");
  const withSuffix = new Uint8Array(complete.length + 3);
  withSuffix.set(complete);
  withSuffix.set([1, 2, 3], complete.length);
  const suffixed = parseSlog(withSuffix);
  assert.equal(suffixed.finalized, true);
  assert.match(suffixed.warnings.join("\n"), /ignored 3 bytes after session footer/);

  const nonMonotonic = fixtureBytes("v2");
  const view = new DataView(nonMonotonic.buffer);
  const headerSize = view.getUint16(10, true);
  const payloadStart = headerSize + 16;
  const payloadBytes = view.getUint16(headerSize + 10, true);
  view.setInt32(payloadStart + 25, view.getInt32(payloadStart, true), true);
  view.setUint32(
    headerSize + 12,
    slogCrc32(nonMonotonic.subarray(payloadStart, payloadStart + payloadBytes)),
    true,
  );
  const session = parseSlog(nonMonotonic);
  assert.equal(session.samples.length, 4);
  assert.match(session.warnings.join("\n"), /not strictly increasing/);
});

test("probable power restoration is an explicit gap with unknown duration", () => {
  const root = asRunRoot(parseSlog(fixtureBytes("v2")));
  const child = cloneSession(root, {
    sessionId: 8,
    continuationOf: root.sessionId,
    continuationKind: "probable_power_restore",
  });
  const run = buildRun([root, child]);
  const firstChild = run.points.find((point) => point.segment === 1);
  const lastRoot = run.points.filter((point) => point.segment === 0).at(-1);

  assert.equal(run.breaks.length, 1);
  assert.equal(run.breaks[0].durationSeconds, null);
  assert.equal(run.breaks[0].continuationKind, "probable_power_restore");
  assert.equal(firstChild.observedSeconds - lastRoot.observedSeconds, 0);
  assert.notEqual(firstChild.observedSeconds, firstChild.relativeSeconds);
  assert.equal(analyzeRun(run).unknown_gap_count, 1);
});

test("v2 max-duration overlap is omitted and continuous time is aligned", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const root = asRunRoot(parsed, {
    finishReason: "max_duration",
    finalRelativeSeconds: parsed.samples.at(-1).relativeSeconds,
    footerRecordCount: parsed.samples.length,
  });
  const template = root.samples[0];
  const childSamples = [-40, -30, -20, -10, 0, 10].map((relativeSeconds) => ({
    ...template,
    relativeSeconds,
  }));
  const child = cloneSession(root, {
    sessionId: 8,
    continuationOf: root.sessionId,
    continuationKind: "max_duration_sample_anchored",
    continuationDelaySeconds: 30,
    startHoldSeconds: 30,
    samples: childSamples,
  });
  const run = buildRun([root, child]);
  const childPoints = run.points.filter((point) => point.segment === 1);

  assert.equal(run.breaks.length, 0);
  assert.deepEqual(
    childPoints.map((point) => [point.relativeSeconds, point.observedSeconds]),
    [
      [-20, 20],
      [-10, 30],
      [0, 40],
      [10, 50],
    ],
  );
  assert.match(run.warnings.join("\n"), /omitted 2 overlapping/);
  assert.equal(analyzeRun(run).unknown_gap_count, 0);
});

test("max-duration metadata that cannot prove continuity remains an unknown gap", () => {
  const root = asRunRoot(parseSlog(fixtureBytes("v2")));
  const child = cloneSession(root, {
    sessionId: 8,
    continuationOf: root.sessionId,
    continuationKind: "max_duration_sample_anchored",
    continuationDelaySeconds: 0,
  });
  const run = buildRun([root, child]);

  assert.equal(root.finishReason, "normal_cooling");
  assert.equal(run.breaks.length, 1);
  assert.equal(run.breaks[0].durationSeconds, null);
  assert.match(run.warnings.join("\n"), /does not prove continuous timing/);

  const zeroSentinel = buildRun([
    asRunRoot(root, {
      finishReason: "max_duration",
      finalRelativeSeconds: root.samples.at(-1).relativeSeconds,
      footerRecordCount: root.samples.length,
    }),
    cloneSession(child, { startHoldSeconds: 0, continuationDelaySeconds: 0 }),
  ]);
  assert.equal(zeroSentinel.breaks.length, 1);
});

test("sample-anchored rollover uses the recorded trigger delay, not the nominal hold", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const root = asRunRoot(parsed, {
    finishReason: "max_duration",
    finalRelativeSeconds: parsed.samples.at(-1).relativeSeconds,
    footerRecordCount: parsed.samples.length,
  });
  const template = root.samples[0];
  const child = cloneSession(root, {
    sessionId: 8,
    continuationOf: root.sessionId,
    continuationKind: "max_duration_sample_anchored",
    continuationDelaySeconds: 50,
    startHoldSeconds: 30,
    samples: [-60, -50, -40, -30, -20, -10, 0, 10].map(
      (relativeSeconds) => ({ ...template, relativeSeconds }),
    ),
  });

  const run = buildRun([root, child]);
  const childPoints = run.points.filter((point) => point.segment === 1);
  assert.equal(run.breaks.length, 0);
  assert.deepEqual(
    childPoints.map((point) => [point.relativeSeconds, point.observedSeconds]),
    [
      [-40, 20],
      [-30, 30],
      [-20, 40],
      [-10, 50],
      [0, 60],
      [10, 70],
    ],
  );
});

test("legacy continuation overlap is not silently presented as continuous", () => {
  const root = asRunRoot(parseSlog(fixtureBytes("v1")));
  const child = cloneSession(root, {
    sessionId: 8,
    continuationOf: root.sessionId,
  });
  const run = buildRun([root, child]);
  assert.equal(run.breaks.length, 1);
  assert.equal(run.breaks[0].durationSeconds, null);
  assert.match(run.warnings.join("\n"), /legacy continuation timing/);
});

test("summary preserves signed raw time and reports only factual hot start state", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const hotFirst = {
    ...parsed.samples[0],
    temperaturesC: [40, null, null, null, null, null, null, null],
  };
  const session = asRunRoot(parsed, {
    samples: [hotFirst, ...parsed.samples.slice(1)],
  });
  const summary = analyzeRun(buildRun([session]));

  assert.equal(summary.start_state, "already_hot_or_warming");
  assert.equal(summary.pretrigger_coverage, "partial");
  assert.equal(summary.expected_first_relative_seconds, -590);
  assert.equal(summary.first_relative_seconds, -20);
  assert.equal(summary.last_relative_seconds, 10);
  assert.deepEqual(summary.chip_temperature_c, {
    minimum: 35,
    maximum: 35,
    mean: 35,
  });
  assert.equal(summary.degraded_sample_count, 0);
  assert.equal(summary.rtc_xtal_fallback_observed, false);
  assert.equal(
    summary.probes[0].threshold_crossing_observed_seconds["40"],
    -20,
  );
  assert.equal(Object.hasOwn(summary, "heater_start_seconds"), false);

  const coolSummary = analyzeRun(buildRun([asRunRoot(parsed)]));
  assert.equal(coolSummary.start_state, "below_trigger_at_first_sample");
});

test("logical run construction rejects unrelated or mismatched sessions", () => {
  const root = asRunRoot(parseSlog(fixtureBytes("v2")));
  assert.throws(
    () => buildRun([root, cloneSession(root, { sessionId: 8, continuationOf: 0 })]),
    (error) =>
      error instanceof SlogAnalysisError && error.code === "broken-continuation",
  );
  const changedSensors = root.sensors.map((sensor, index) =>
    index === 7 ? { ...sensor, relativeHeightCm: -999 } : sensor,
  );
  assert.throws(
    () =>
      buildRun([
        root,
        cloneSession(root, {
          sessionId: 8,
          continuationOf: root.sessionId,
          sensors: changedSensors,
        }),
      ]),
    (error) =>
      error instanceof SlogAnalysisError && error.code === "layout-mismatch",
  );
});

test("catalog grouping returns only unambiguous root-to-leaf runs", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const root = cloneSession(parsed, { continuationOf: 0, continuationKind: "none" });
  const child = cloneSession(parsed, {
    sessionId: 8,
    continuationOf: root.sessionId,
    continuationKind: "probable_power_restore",
  });
  const independent = cloneSession(parsed, {
    sessionId: 20,
    continuationOf: 0,
    continuationKind: "none",
  });
  const catalog = groupSessionsIntoRuns([child, independent, root]);

  assert.deepEqual(
    catalog.groups.map((group) => [group.status, [...group.sessionIds]]),
    [
      ["ready", [7, 8]],
      ["ready", [20]],
    ],
  );
  assert.deepEqual(
    catalog.runs.map((sessions) => sessions.map((session) => session.sessionId)),
    [
      [7, 8],
      [20],
    ],
  );
});

test("catalog grouping reports missing parents, branches, duplicates, and cycles", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const missing = cloneSession(parsed, {
    sessionId: 30,
    continuationOf: 29,
  });
  let catalog = groupSessionsIntoRuns([missing]);
  assert.equal(catalog.runs.length, 0);
  assert.equal(catalog.groups[0].status, "incomplete");
  assert.deepEqual(
    catalog.groups[0].issues.map((issue) => issue.code),
    ["missing-parent"],
  );

  const root = cloneSession(parsed, { continuationOf: 0 });
  const firstChild = cloneSession(parsed, {
    sessionId: 8,
    continuationOf: root.sessionId,
  });
  const secondChild = cloneSession(parsed, {
    sessionId: 9,
    continuationOf: root.sessionId,
  });
  catalog = groupSessionsIntoRuns([root, firstChild, secondChild]);
  assert.equal(catalog.runs.length, 0);
  assert.equal(catalog.groups[0].status, "ambiguous");
  assert.ok(
    catalog.groups[0].issues.some(
      (issue) => issue.code === "continuation-branch",
    ),
  );

  const duplicate = cloneSession(root);
  catalog = groupSessionsIntoRuns([root, duplicate]);
  assert.equal(catalog.groups[0].status, "ambiguous");
  assert.ok(
    catalog.groups[0].issues.some(
      (issue) => issue.code === "duplicate-session-id",
    ),
  );

  const cycleA = cloneSession(parsed, { sessionId: 40, continuationOf: 41 });
  const cycleB = cloneSession(parsed, { sessionId: 41, continuationOf: 40 });
  catalog = groupSessionsIntoRuns([cycleA, cycleB]);
  assert.equal(catalog.groups[0].status, "ambiguous");
  assert.ok(
    catalog.groups[0].issues.some(
      (issue) => issue.code === "continuation-cycle",
    ),
  );
});

test("catalog grouping never links a continuation across probe layouts", () => {
  const parsed = parseSlog(fixtureBytes("v2"));
  const root = cloneSession(parsed, { continuationOf: 0 });
  const sensors = parsed.sensors.map((sensor, index) =>
    index === 7 ? { ...sensor, relativeHeightCm: -999 } : sensor,
  );
  const child = cloneSession(parsed, {
    sessionId: 8,
    continuationOf: root.sessionId,
    sensors,
  });
  const catalog = groupSessionsIntoRuns([root, child]);

  assert.equal(catalog.groups.length, 2);
  assert.deepEqual(
    catalog.groups.map((group) => group.status),
    ["ready", "incomplete"],
  );
  assert.deepEqual(catalog.runs.map((run) => run.map((item) => item.sessionId)), [
    [7],
  ]);
  assert.equal(catalog.groups[1].issues[0].code, "layout-mismatch");
});
