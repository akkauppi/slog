import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DataWorkspace,
  buildProbeRateSeries,
  buildProbeSeries,
  groupCatalogSessions,
} from "../../portal/js/data-workspace.js";
import { DeletionOutcomeUncertainError } from "../../portal/js/log-management.js";
import {
  createRunWorkbook,
  runExportFilename,
  serializeRunCsv,
} from "../../portal/js/session-export.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function catalogEntry(id, continuationOf = 0) {
  return Object.freeze({
    id,
    bytes: 100,
    state: "finalized",
    reason: 1,
    version: 2,
    bootId: id,
    resetReason: 1,
    continuationOf,
    continuationKind: continuationOf ? 2 : 0,
  });
}

function point(observedSeconds, temperatureC, segment = 0) {
  return Object.freeze({
    observedSeconds,
    segment,
    temperaturesC: Object.freeze([temperatureC, null, null, null, null, null, null, null]),
  });
}

function exportRun() {
  return {
    sessions: [{ sessionId: 10 }, { sessionId: 11 }],
    sensors: Array.from({ length: 8 }, (_, index) => ({
      rom: `28FF0000000000${index}`,
      relativeHeightCm: index * -20,
    })),
    breaks: [{
      afterSegment: 0,
      beforeSegment: 1,
      continuationKind: "probable_power_restore",
      durationSeconds: null,
    }],
    points: [
      {
        observedSeconds: 0,
        segment: 0,
        sessionId: 10,
        relativeSeconds: 0,
        temperaturesC: [40, 39, 38, 37, 36, 35, 34, null],
        chipTemperatureC: 28.5,
        statusFlags: 0,
      },
      {
        observedSeconds: 0,
        segment: 1,
        sessionId: 11,
        relativeSeconds: -590,
        temperaturesC: [41, 40, 39, 38, 37, 36, 35, 34],
        chipTemperatureC: 29,
        statusFlags: 2,
      },
    ],
  };
}

test("CSV export keeps segment time and marks unknown power gaps", () => {
  const csv = serializeRunCsv(exportRun());
  const lines = csv.trim().replace(/^\ufeff/, "").split("\r\n");
  assert.match(lines[0], /observed_seconds_excluding_unknown_gaps/);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].split(",")[4], "");
  assert.equal(lines[2].split(",")[3], "-590");
  assert.equal(lines[2].split(",")[4], "yes");
  assert.equal(lines[1].split(",")[12], "");
  assert.equal(runExportFilename(exportRun(), "CSV"), "sauna-run-10-11.csv");
});

test("Excel export is an XLSX package with measurements, probes, and gaps", () => {
  const workbook = createRunWorkbook(exportRun());
  assert.equal(new DataView(workbook.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(
    new DataView(workbook.buffer).getUint32(workbook.length - 22, true),
    0x06054b50,
  );
  const packageText = new TextDecoder().decode(workbook);
  assert.match(packageText, /Measurements/);
  assert.match(packageText, /Probes/);
  assert.match(packageText, /Gaps/);
  assert.match(packageText, /probable_power_restore/);
  assert.match(packageText, /unknown/);
});

test("device catalog forms only validated root-to-leaf chains", () => {
  const root = catalogEntry(10);
  const middle = catalogEntry(11, 10);
  const leaf = catalogEntry(12, 11);
  const chains = groupCatalogSessions([leaf, root, middle]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].safe, true);
  assert.deepEqual(chains[0].sessionIds, [10, 11, 12]);
});

test("malformed catalogs keep every raw entry visible but disable grouping", () => {
  const duplicateA = catalogEntry(10);
  const duplicateB = catalogEntry(10);
  const missingParent = catalogEntry(12, 11);
  const chains = groupCatalogSessions([duplicateA, duplicateB, missingParent]);
  assert.equal(chains.length, 3);
  assert.ok(chains.every((chain) => !chain.safe));
  assert.deepEqual(chains.map((chain) => chain.sessions[0]), [
    duplicateA,
    duplicateB,
    missingParent,
  ]);
  assert.match(chains[0].issue, /unsafe/i);
});

test("per-entry parse issues survive catalog grouping and disable removal", () => {
  const catalog = [catalogEntry(10)];
  Object.defineProperty(catalog, "entryIssues", {
    value: Object.freeze([Object.freeze({
      code: "malformed_session_entry",
      entry: 2,
      message: "LOG_SESSION is missing bytes",
    })]),
  });
  Object.freeze(catalog);
  const chains = groupCatalogSessions(catalog);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].safe, false);
  assert.match(chains[0].issue, /entry 2/i);
  assert.match(chains[0].issue, /missing bytes/i);
});

test("an all-malformed device catalog retains visible issue metadata", () => {
  const catalog = [];
  Object.defineProperty(catalog, "entryIssues", {
    value: Object.freeze([Object.freeze({
      code: "malformed_session_entry",
      entry: 1,
      message: "LOG_SESSION has invalid id",
    })]),
  });
  Object.freeze(catalog);
  const chains = groupCatalogSessions(catalog);
  assert.equal(chains.length, 0);
  assert.equal(chains.issues.length, 1);
  assert.equal(chains.issues[0].entry, 1);
});

test("timeline connects proven continuations and splits only unknown gaps or missing readings", () => {
  const run = {
    points: [
      point(0, 20, 0),
      point(10, 21, 0),
      point(20, 22, 1),
      point(30, null, 1),
      point(40, 24, 1),
      point(50, 25, 2),
    ],
    breaks: [{ afterSegment: 1, beforeSegment: 2, observedSeconds: 45 }],
  };
  assert.deepEqual(
    buildProbeSeries(run, 0).map((piece) => piece.map((value) => value.observedSeconds)),
    [[0, 10, 20], [40], [50]],
  );
});

test("bounded chart decimation retains local extrema and endpoints", () => {
  const temperatures = [20, 21, 22, 80, 23, 24, 5, 25, 26, 27, 28, 29];
  const run = {
    points: temperatures.map((temperature, index) => point(index * 10, temperature)),
    breaks: [],
  };
  const [series] = buildProbeSeries(run, 0, 6);
  assert.ok(series.length <= 6);
  assert.equal(series[0].temperatureC, 20);
  assert.equal(series.at(-1).temperatureC, 29);
  assert.ok(series.some((value) => value.temperatureC === 80));
  assert.ok(series.some((value) => value.temperatureC === 5));
});

test("selected-probe derivative uses degrees per minute and never crosses missing data or gaps", () => {
  const run = {
    points: [
      point(0, 20, 0),
      point(10, 21, 0),
      point(20, null, 0),
      point(30, 23, 0),
      point(40, 24, 0),
      point(50, 25, 1),
      point(60, 26, 1),
    ],
    breaks: [{ afterSegment: 0, beforeSegment: 1, observedSeconds: 45 }],
  };
  const rates = buildProbeRateSeries(run, 0);
  assert.deepEqual(
    rates.map((piece) => piece.map((value) => value.observedSeconds)),
    [[0, 10], [30, 40], [50, 60]],
  );
  for (const sample of rates.flat()) {
    assert.ok(Math.abs(sample.rateCPerMin - 6) < 1e-9);
  }
});

test("an empty selected run refreshes the probe table before chart fallback", () => {
  const rendered = [];
  const chartChildren = [];
  const rateChildren = [];
  const context = {
    analysisRuns: [{
      run: {
        points: [point(0, null)],
        breaks: [],
      },
      analysis: { probes: [{ position: 1, valid_samples: 0 }] },
    }],
    selectedRun: 0,
    probeSelect: { value: "1" },
    renderProbeTable(analysis) {
      rendered.push(analysis);
    },
    chart: {
      replaceChildren() {
        chartChildren.length = 0;
      },
      append(child) {
        chartChildren.push(child);
      },
    },
    rateChart: {
      replaceChildren() {
        rateChildren.length = 0;
      },
      append(child) {
        rateChildren.push(child);
      },
    },
    gapNote: { hidden: false, textContent: "stale gap" },
    emptyState(text) {
      return { text };
    },
  };

  DataWorkspace.prototype.renderChart.call(context);

  assert.deepEqual(rendered, [context.analysisRuns[0].analysis]);
  assert.deepEqual(chartChildren, [{ text: "No committed temperature samples are available." }]);
  assert.deepEqual(rateChildren, [{ text: "No derivative is available." }]);
  assert.equal(context.gapNote.hidden, true);
  assert.equal(context.gapNote.textContent, "");
});

test("removal override requires a CRC-validated Quick download for every unverified segment", () => {
  const first = catalogEntry(10);
  const second = catalogEntry(11, 10);
  const chain = Object.freeze({
    safe: true,
    sessions: Object.freeze([first, second]),
    sessionIds: Object.freeze([10, 11]),
  });
  const key = (session) => [
    session.id,
    session.bytes,
    session.state,
    session.version,
    session.bootId,
    session.continuationOf,
    session.continuationKind,
  ].join(":");
  const context = {
    manager: {},
    window: {},
    status: {
      active: false,
      commissioning: false,
      restartRequired: false,
      continuationPendingSessionId: 0,
      retention: {
        pendingSegment: 0,
        pendingRun: 0,
        auditOk: true,
        catalogInvalid: false,
        catalogOverflow: false,
      },
    },
    receipts: new Map(),
    quickDownloads: new Set([key(first)]),
    downloads: new Map([[first, { download: {} }]]),
  };

  let readiness = DataWorkspace.prototype.removalReadiness.call(context, chain);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /missing #11/i);

  context.quickDownloads.add(key(second));
  context.downloads.set(second, { download: {} });
  readiness = DataWorkspace.prototype.removalReadiness.call(context, chain);
  assert.deepEqual(readiness, {
    ready: true,
    reason: "One or more saved copies are not verified. Removal requires an explicit override.",
    allowUnverified: true,
  });

  context.status.continuationPendingSessionId = 10;
  readiness = DataWorkspace.prototype.removalReadiness.call(context, chain);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /protected/i);
});

test("lost delete confirmation reports the refreshed catalog without changing local-file claims", async () => {
  const session = catalogEntry(10);
  const chain = Object.freeze({
    safe: true,
    sessions: Object.freeze([session]),
    sessionIds: Object.freeze([session.id]),
  });
  const message = {
    hidden: true,
    textContent: "",
    className: "",
    setAttribute() {},
    classList: { add() {} },
  };
  const context = {
    operation: null,
    manager: {
      async deletePreserved() {
        throw new DeletionOutcomeUncertainError(session.id);
      },
    },
    catalog: [session],
    receipts: new Map([[
      [
        session.id,
        session.bytes,
        session.state,
        session.version,
        session.bootId,
        session.continuationOf,
        session.continuationKind,
      ].join(":"),
      {},
    ]]),
    downloads: new Map(),
    recordsMessage: message,
    removalReadiness: () => ({ ready: true, reason: "" }),
    beginOperation() {},
    endOperation() {},
    onActivity() {},
    async refreshUnlocked() {
      this.catalog = [session];
    },
  };

  await DataWorkspace.prototype.removeRun.call(context, chain);

  assert.match(message.textContent, /deletion confirmation for session 10 was lost/i);
  assert.match(message.textContent, /refreshed catalog still lists session 10/i);
  assert.match(message.textContent, /verified local files were not changed/i);
  assert.doesNotMatch(message.textContent, /nothing was removed/i);
});

test("portal offers guarded preservation and whole-chain newest-first removal", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "portal/js/data-workspace.js"),
    "utf8",
  );
  assert.match(
    source,
    /showSaveFilePicker[\s\S]*?validatedDownload\(session\)[\s\S]*?preserveToFile/,
    "the save picker must be acquired before asynchronous device download",
  );
  assert.match(source, /\[\.\.\.chain\.sessions\]\.reverse\(\)/);
  assert.match(
    source,
    /const receipt = this\.receipts\.get\(sessionReceiptKey\(session\)\)[\s\S]*?deletePreserved\(receipt\)/,
  );
  assert.match(source, /deleteDownloaded\(this\.downloads\.get\(session\)\?\.download\)/);
  assert.match(source, /groupCatalogSessions\(catalog\)/);
  assert.doesNotMatch(source, /groupCatalogSessions\(\[\.\.\.catalog\]\)/);
  assert.match(source, /failure instanceof DeletionOutcomeUncertainError/);
  assert.match(source, /localCopyState = allowUnverified[\s\S]*?verified local files were not changed/i);
  assert.match(source, /Deletion confirmation for session[\s\S]*?\$\{localCopyState\}/);
  assert.doesNotMatch(source, /nothing was removed/i);
  assert.doesNotMatch(source, /LOG FORMAT|LOG CRASH ERASE|rawBytes.*diagnostic/i);
});

test("a newly chosen records port closes after identity verification fails", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "portal/js/app.js"),
    "utf8",
  );
  assert.match(
    source,
    /async function connectRecordsLogger\(\)[\s\S]*?openedForRecords = true[\s\S]*?requireCompatibleDevice\(await recordsClient\.info\(\)\)[\s\S]*?catch \(error\) \{[\s\S]*?if \(openedForRecords\) \{[\s\S]*?await discardNewRecordsTransport\(\);/,
  );
});
