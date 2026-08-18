import assert from "node:assert/strict";
import test from "node:test";

import {
  CommitOutcomeUnknownError,
  CommissioningMethod,
  CommissioningPhase,
  CommissioningWorkflowError,
  ConnectCommissioningController,
  WARM_BASELINE_MAX_SPAN_C,
  WARM_BASELINE_SCAN_COUNT,
  buildMappingDocument,
  buildWarmBaseline,
  evaluateWarmScan,
  matchPendingMapping,
  parseMappingDocument,
  serializeMappingDocument,
  verifyCommittedReadback,
  verifyPostRebootState,
} from "../../portal/js/commissioning.js";

const ROMS = Object.freeze([
  "2825E1BD00000058",
  "2856BE530000003F",
  "287C38C000000078",
  "28D92E50000000CE",
  "289ABC52000000D1",
  "28CD19520000009B",
  "28939352000000D0",
  "2801F3520000001E",
]);
const OTHER_ROM = "280102030405069E";

function deviceInfo(overrides = {}) {
  return {
    protocol: 1,
    product: "sauna_logger",
    firmware: "0.3.0-test",
    commit: "test",
    partition: "sauna_ota_v1",
    ota: "app0",
    configured: false,
    activeGeneration: 0,
    restartRequired: false,
    commissioning: false,
    ...overrides,
  };
}

function configuration(
  roms = [],
  { generation = 0, crc32 = "00000000", restartRequired = false } = {},
) {
  return {
    state: roms.length ? "valid" : "unconfigured",
    generation,
    geometry: roms.length ? "column8_20cm_v1" : "none",
    probes: roms.map((rom, index) => ({
      position: index + 1,
      relativeHeightCm: index * -20,
      rom,
    })),
    crc32,
    validSlots: roms.length ? 1 : 0,
    detail: roms.length ? "ready" : "missing",
    restartRequired,
  };
}

function scan(
  roms,
  {
    mapped = false,
    missingTemperature = [],
    temperatures = {},
    busCount = roms.length,
    overflow = false,
  } = {},
) {
  const missing = new Set(missingTemperature);
  return {
    probes: roms.map((rom, index) => ({
      rom,
      temperatureC: missing.has(rom)
        ? null
        : Object.hasOwn(temperatures, rom)
          ? temperatures[rom]
          : 20 + index / 4,
      mappedPosition: mapped ? ROMS.indexOf(rom) + 1 : 0,
    })),
    busCount,
    overflow,
  };
}

function warmBaselineScans({ spans = {}, orders = [] } = {}) {
  const offsets = [-0.2, 0.1, 0, 0.2, -0.1];
  return offsets.map((offset, scanIndex) => {
    const temperatures = Object.fromEntries(
      ROMS.map((rom, romIndex) => {
        const spanOffset = spans[rom]?.[scanIndex] ?? offset;
        return [rom, 20 + romIndex / 4 + spanOffset];
      }),
    );
    return scan(orders[scanIndex] ?? ROMS, { temperatures });
  });
}

class FakeClient {
  constructor({
    infos = [],
    configurations = [],
    scans = [],
    commitResult = { generation: 7, crc32: "89ABCDEF", rebootRequired: true },
    abortResult = { restartRequired: false },
    failures = {},
  } = {}) {
    this.infos = [...infos];
    this.configurations = [...configurations];
    this.scans = [...scans];
    this.commitResult = commitResult;
    this.abortResult = abortResult;
    this.failures = new Map(
      Object.entries(failures).map(([method, errors]) => [
        method,
        Array.isArray(errors) ? [...errors] : [errors],
      ]),
    );
    this.calls = [];
  }

  _failure(method) {
    const errors = this.failures.get(method);
    if (errors?.length) throw errors.shift();
  }

  _shift(values, method) {
    if (!values.length) throw new Error(`No fake ${method} response remains.`);
    return values.shift();
  }

  async info() {
    this.calls.push(["info"]);
    this._failure("info");
    return this._shift(this.infos, "info");
  }

  async getConfiguration() {
    this.calls.push(["getConfiguration"]);
    this._failure("getConfiguration");
    return this._shift(this.configurations, "getConfiguration");
  }

  async begin(geometry) {
    this.calls.push(["begin", geometry]);
    this._failure("begin");
  }

  async scan() {
    this.calls.push(["scan"]);
    this._failure("scan");
    return this._shift(this.scans, "scan");
  }

  async setProbe(position, rom) {
    this.calls.push(["setProbe", position, rom]);
    this._failure("setProbe");
  }

  async commit() {
    this.calls.push(["commit"]);
    this._failure("commit");
    return this.commitResult;
  }

  async abort() {
    this.calls.push(["abort"]);
    this._failure("abort");
    return this.abortResult;
  }

  async keepalive() {
    this.calls.push(["keepalive"]);
    this._failure("keepalive");
  }

  async reboot() {
    this.calls.push(["reboot"]);
    this._failure("reboot");
  }
}

function identificationScans() {
  return [scan([]), ...ROMS.map((_, index) => scan(ROMS.slice(0, index + 1)))];
}

async function identifyAll(controller) {
  await controller.inspect();
  await controller.start();
  await controller.confirmEmptyBus();
  for (let position = 1; position <= ROMS.length; position += 1) {
    const result = await controller.identifyNextProbe();
    assert.equal(result.position, position);
    assert.equal(result.rom, ROMS[position - 1]);
  }
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY_TO_COMMIT);
}

function clientReadyForIdentification(extra = {}) {
  return new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: identificationScans(),
    ...extra,
  });
}

test("mapping documents match the Python-compatible partial and verified shape", () => {
  const partial = buildMappingDocument([ROMS[0].toLowerCase(), ROMS[1]]);
  assert.equal(partial.schema_version, 1);
  assert.equal(partial.one_wire_pin, "D2");
  assert.equal(partial.geometry, "column8_20cm_v1");
  assert.deepEqual(
    partial.sensors.map(({ position_from_reference_end, relative_height_cm, rom }) => [
      position_from_reference_end,
      relative_height_cm,
      rom,
    ]),
    [
      [1, 0, ROMS[0]],
      [2, -20, ROMS[1]],
    ],
  );
  assert.deepEqual(parseMappingDocument(partial), {
    roms: [ROMS[0], ROMS[1]],
    configuration: null,
  });

  const verified = buildMappingDocument(ROMS, {
    generation: 7,
    crc32: "89abcdef",
  });
  assert.equal(verified.configuration_generation, 7);
  assert.equal(verified.configuration_crc32, "89ABCDEF");
  assert.deepEqual(parseMappingDocument(verified).roms, ROMS);
  assert.equal(`${JSON.stringify(verified, null, 2)}\n`, serializeMappingDocument(verified));
});

test("saved pending mappings match only a complete exact active configuration", () => {
  const active = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
  });
  const pending = {
    ...buildMappingDocument(ROMS),
    portal_phase: CommissioningPhase.RECOVERY_REQUIRED,
    commit_outcome: "unknown",
  };

  assert.deepEqual(matchPendingMapping(pending, active), {
    roms: ROMS,
    generation: 7,
    crc32: "89ABCDEF",
  });
  assert.deepEqual(
    matchPendingMapping(
      { ...pending, commit_generation: 7, commit_crc32: "89abcdef" },
      active,
    ),
    { roms: ROMS, generation: 7, crc32: "89ABCDEF" },
  );
  assert.equal(matchPendingMapping(buildMappingDocument(ROMS.slice(0, 7)), active), null);

  const reordered = [...ROMS];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(matchPendingMapping(buildMappingDocument(reordered), active), null);
  assert.equal(
    matchPendingMapping(
      { ...pending, commit_generation: 8, commit_crc32: "89ABCDEF" },
      active,
    ),
    null,
  );
  assert.equal(
    matchPendingMapping({ ...pending, commit_generation: 7 }, active),
    null,
  );
});

test("mapping document loading rejects reordered geometry and partial verification metadata", () => {
  const reordered = buildMappingDocument(ROMS.slice(0, 2));
  reordered.sensors[1].position_from_reference_end = 8;
  assert.throws(
    () => parseMappingDocument(reordered),
    (error) => error.code === "invalid-mapping-document",
  );

  const incomplete = buildMappingDocument(ROMS);
  incomplete.configuration_generation = 7;
  assert.throws(
    () => parseMappingDocument(incomplete),
    (error) => error.code === "invalid-mapping-document",
  );
});

test("warm baseline uses five per-ROM medians independent of discovery order", () => {
  const scans = warmBaselineScans({
    orders: [ROMS, [...ROMS].reverse(), ROMS, [...ROMS].reverse(), ROMS],
  });
  const baseline = buildWarmBaseline(scans);

  assert.equal(WARM_BASELINE_SCAN_COUNT, 5);
  assert.equal(WARM_BASELINE_MAX_SPAN_C, 0.5);
  assert.equal(Object.keys(baseline).length, 8);
  assert.equal(baseline[ROMS[0]], 20);
  assert.equal(baseline[ROMS[7]], 21.75);
});

test("warm baseline rejects incomplete, changing, invalid, and unstable probe scans", () => {
  assert.throws(
    () => buildWarmBaseline(warmBaselineScans().slice(0, 4)),
    (error) => error.code === "invalid-baseline-scan-count",
  );

  const incomplete = warmBaselineScans();
  incomplete[2] = scan(ROMS.slice(0, 7));
  assert.throws(
    () => buildWarmBaseline(incomplete),
    (error) => error.code === "probe-set-mismatch",
  );

  const changed = warmBaselineScans();
  const changedRoms = [OTHER_ROM, ...ROMS.slice(1)];
  changed[2] = scan(changedRoms);
  assert.throws(
    () => buildWarmBaseline(changed),
    (error) => error.code === "probe-set-mismatch",
  );

  const missingTemperature = warmBaselineScans();
  missingTemperature[1] = scan(ROMS, { missingTemperature: [ROMS[3]] });
  assert.throws(
    () => buildWarmBaseline(missingTemperature),
    (error) => error.code === "missing-temperature",
  );

  const unstable = warmBaselineScans({
    spans: { [ROMS[4]]: [-0.3, 0.3, 0, 0.2, -0.1] },
  });
  assert.throws(
    () => buildWarmBaseline(unstable),
    (error) => error.code === "unstable-warm-baseline",
  );
});

test("warm scan selection requires an exact set, clear rise, and last-probe margin from zero", () => {
  const baseline = buildWarmBaseline(warmBaselineScans());
  const temperatures = { ...baseline, [ROMS[0]]: baseline[ROMS[0]] + 3.5 };
  let outcome = evaluateWarmScan(scan(ROMS, { temperatures }), baseline);
  assert.equal(outcome.candidate.rom, ROMS[0]);
  assert.equal(outcome.accepted.rom, ROMS[0]);

  temperatures[ROMS[1]] = baseline[ROMS[1]] + 2.75;
  outcome = evaluateWarmScan(scan(ROMS, { temperatures }), baseline);
  assert.equal(outcome.candidate.marginC, 0.75);
  assert.equal(outcome.accepted, null);

  const lastTemperatures = { ...baseline, [ROMS[7]]: baseline[ROMS[7]] + 0.5 };
  outcome = evaluateWarmScan(
    scan(ROMS, { temperatures: lastTemperatures }),
    baseline,
    ROMS.slice(0, 7),
  );
  assert.equal(outcome.candidate.rom, ROMS[7]);
  assert.equal(outcome.candidate.marginC, 0.5);
  assert.equal(outcome.accepted, null);

  lastTemperatures[ROMS[7]] = baseline[ROMS[7]] + 3;
  outcome = evaluateWarmScan(
    scan(ROMS, { temperatures: lastTemperatures }),
    baseline,
    ROMS.slice(0, 7),
  );
  assert.equal(outcome.candidate.marginC, 3);
  assert.equal(outcome.accepted.rom, ROMS[7]);

  assert.throws(
    () => evaluateWarmScan(scan(ROMS.slice(0, 7)), baseline),
    (error) => error.code === "probe-set-mismatch",
  );
});

test("existing valid mappings require an explicit replacement decision", async () => {
  const active = configuration(ROMS, {
    generation: 6,
    crc32: "0123ABCD",
  });
  const client = new FakeClient({
    infos: [deviceInfo({ configured: true, activeGeneration: 6 })],
    configurations: [active],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  await assert.rejects(
    controller.start(),
    (error) => error.code === "replacement-not-confirmed",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY);

  await controller.start({ replaceExisting: true });
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_EMPTY_BUS);
  assert.deepEqual(client.calls.at(-1), ["begin", "column8_20cm_v1"]);
});

test("inspection fails closed when SYS INFO and CFG GET disagree", async () => {
  const active = configuration(ROMS, {
    generation: 6,
    crc32: "0123ABCD",
  });
  const generationMismatch = new ConnectCommissioningController(
    new FakeClient({
      infos: [deviceInfo({ configured: true, activeGeneration: 5 })],
      configurations: [active],
    }),
  );
  await assert.rejects(
    generationMismatch.inspect(),
    (error) => error.code === "configuration-state-mismatch",
  );

  const restartMismatch = new ConnectCommissioningController(
    new FakeClient({
      infos: [
        deviceInfo({
          configured: true,
          activeGeneration: 6,
          restartRequired: true,
        }),
      ],
      configurations: [active],
    }),
  );
  await assert.rejects(
    restartMismatch.inspect(),
    (error) => error.code === "configuration-state-mismatch",
  );
});

test("the empty-bus gate remains retryable and keeps the transaction visible", async () => {
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: [scan([ROMS[0]])],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start();

  await assert.rejects(
    controller.confirmEmptyBus(),
    (error) => error.code === "bus-not-empty",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_EMPTY_BUS);
  assert.equal(controller.snapshot.transactionOpen, true);

  await controller.abort();
  assert.equal(controller.snapshot.phase, CommissioningPhase.ABORTED);
  assert.equal(controller.snapshot.transactionOpen, false);
});

test("inspection treats a firmware-reported commissioning lock as unsafe", async () => {
  const client = new FakeClient({
    infos: [deviceInfo({ commissioning: true })],
    configurations: [configuration()],
  });
  const controller = new ConnectCommissioningController(client);

  await controller.inspect();

  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(controller.snapshot.transactionOpen, true);
  await controller.abort();
  assert.equal(controller.snapshot.phase, CommissioningPhase.ABORTED);
  assert.equal(controller.snapshot.transactionOpen, false);
});

test("connect-one-at-a-time rejects disappeared probes without changing the draft", async () => {
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: [scan([]), scan([ROMS[0]]), scan([ROMS[1]])],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start();
  await controller.confirmEmptyBus();
  await controller.identifyNextProbe();

  await assert.rejects(controller.identifyNextProbe(), /disappeared/);
  assert.deepEqual(controller.snapshot.mappedRoms, [ROMS[0]]);
  assert.equal(controller.snapshot.nextPosition, 2);
  assert.equal(controller.snapshot.phase, CommissioningPhase.IDENTIFYING);
});

test("connect-one-at-a-time requires valid temperatures and exactly one addition", async () => {
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: [
      scan([]),
      scan([ROMS[0]], { missingTemperature: [ROMS[0]] }),
      scan([ROMS[0], ROMS[1]]),
    ],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start();
  await controller.confirmEmptyBus();

  await assert.rejects(
    controller.identifyNextProbe(),
    (error) => error.code === "missing-temperature",
  );
  await assert.rejects(controller.identifyNextProbe(), /exactly one new probe/);
  assert.deepEqual(controller.snapshot.mappedRoms, []);
});

test("warm commissioning learns a strict five-scan baseline before identification", async () => {
  const baselineScans = warmBaselineScans();
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: baselineScans,
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  await assert.rejects(
    controller.start({ method: "unknown" }),
    (error) => error.code === "invalid-commissioning-method",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY);
  assert.equal(client.calls.some(([method]) => method === "begin"), false);

  await controller.start({ method: CommissioningMethod.WARM });
  assert.equal(controller.snapshot.method, CommissioningMethod.WARM);
  assert.equal(
    controller.snapshot.phase,
    CommissioningPhase.AWAITING_WARM_BASELINE,
  );

  await controller.captureWarmBaseline();
  assert.equal(controller.snapshot.phase, CommissioningPhase.IDENTIFYING_WARM);
  assert.equal(Object.keys(controller.snapshot.warmBaseline).length, 8);
  assert.equal(
    client.calls.filter(([method]) => method === "scan").length,
    WARM_BASELINE_SCAN_COUNT,
  );
});

test("warm commissioning requires the same eligible winner in two fresh scans", async () => {
  const baselineScans = warmBaselineScans();
  const baseline = buildWarmBaseline(baselineScans);
  const warmed = (rom, riseC) =>
    scan(ROMS, { temperatures: { ...baseline, [rom]: baseline[rom] + riseC } });
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: [
      ...baselineScans,
      warmed(ROMS[0], 4),
      warmed(ROMS[1], 4),
      warmed(ROMS[0], 4),
      warmed(ROMS[0], 3.5),
    ],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start({ method: CommissioningMethod.WARM });
  await controller.captureWarmBaseline();

  const ambiguous = await controller.identifyNextWarmedProbe();
  assert.equal(ambiguous.accepted, null);
  assert.deepEqual(
    ambiguous.candidates.map(({ rom }) => rom),
    [ROMS[0], ROMS[1]],
  );
  assert.deepEqual(controller.snapshot.mappedRoms, []);
  assert.equal(controller.snapshot.phase, CommissioningPhase.IDENTIFYING_WARM);

  const accepted = await controller.identifyNextWarmedProbe();
  assert.equal(accepted.position, 1);
  assert.equal(accepted.accepted.rom, ROMS[0]);
  assert.deepEqual(controller.snapshot.mappedRoms, [ROMS[0]]);
  assert.equal(controller.snapshot.nextPosition, 2);
});

test("warm commissioning never maps from a partial confirmation or invalid scan", async () => {
  const baselineScans = warmBaselineScans();
  const baseline = buildWarmBaseline(baselineScans);
  const warming = scan(ROMS, {
    temperatures: { ...baseline, [ROMS[0]]: baseline[ROMS[0]] + 4 },
  });
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    scans: [
      ...baselineScans,
      warming,
      scan(ROMS, { missingTemperature: [ROMS[7]] }),
    ],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start({ method: CommissioningMethod.WARM });
  await controller.captureWarmBaseline();

  await assert.rejects(
    controller.identifyNextWarmedProbe(),
    (error) => error.code === "missing-temperature",
  );
  assert.deepEqual(controller.snapshot.mappedRoms, []);
  assert.equal(controller.snapshot.phase, CommissioningPhase.IDENTIFYING_WARM);
  assert.equal(controller.snapshot.transactionOpen, true);
});

test("warm commissioning preserves P1-P8 order through commit, reboot, and live verification", async () => {
  const baselineScans = warmBaselineScans();
  const baseline = buildWarmBaseline(baselineScans);
  const warmed = (rom, riseC) =>
    scan([...ROMS].reverse(), {
      temperatures: { ...baseline, [rom]: baseline[rom] + riseC },
    });
  const committed = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration(), committed],
    scans: [
      ...baselineScans,
      ...ROMS.flatMap((rom) => [warmed(rom, 4), warmed(rom, 3.5)]),
      scan([...ROMS].reverse()),
    ],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start({ method: CommissioningMethod.WARM });
  await controller.captureWarmBaseline();

  for (let index = 0; index < ROMS.length; index += 1) {
    const result = await controller.identifyNextWarmedProbe();
    assert.equal(result.position, index + 1);
    assert.equal(result.accepted.rom, ROMS[index]);
  }
  assert.deepEqual(controller.snapshot.mappedRoms, ROMS);
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY_TO_COMMIT);

  const readback = await controller.commit();
  assert.equal(readback.generation, 7);
  assert.deepEqual(
    client.calls.filter(([method]) => method === "setProbe"),
    ROMS.map((rom, index) => ["setProbe", index + 1, rom]),
  );

  await controller.reboot();
  const active = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: false,
  });
  const reconnected = new FakeClient({
    infos: [
      deviceInfo({
        configured: true,
        activeGeneration: 7,
        restartRequired: false,
      }),
    ],
    configurations: [active],
    scans: [scan([...ROMS].reverse(), { mapped: true })],
  });
  const exported = await controller.verifyAfterReconnect(reconnected);

  assert.equal(controller.snapshot.phase, CommissioningPhase.COMPLETE);
  assert.deepEqual(
    exported.sensors.map(({ rom }) => rom),
    ROMS,
  );
  assert.equal(exported.configuration_generation, 7);
  assert.equal(exported.configuration_crc32, "89ABCDEF");
  assert.deepEqual(exported, controller.exportVerifiedMapping());
  assert.deepEqual(
    reconnected.calls.map(([method]) => method),
    ["info", "getConfiguration", "begin", "scan", "abort"],
  );
});

test("happy path verifies commit readback, reboot activation, live scan, and export", async () => {
  const committed = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  const client = clientReadyForIdentification({
    configurations: [configuration(), committed],
    scans: [...identificationScans(), scan(ROMS)],
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  assert.equal(controller.snapshot.draft.sensors.length, 8);

  const readback = await controller.commit();
  assert.equal(readback.generation, 7);
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY_TO_REBOOT);
  assert.deepEqual(
    client.calls.filter(([method]) => method === "setProbe"),
    ROMS.map((rom, index) => ["setProbe", index + 1, rom]),
  );

  await controller.reboot();
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_RECONNECT);

  const active = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: false,
  });
  const reconnected = new FakeClient({
    infos: [
      deviceInfo({
        configured: true,
        activeGeneration: 7,
        restartRequired: false,
      }),
    ],
    configurations: [active],
    scans: [scan(ROMS, { mapped: true })],
  });
  const exported = await controller.verifyAfterReconnect(reconnected);

  assert.equal(controller.snapshot.phase, CommissioningPhase.COMPLETE);
  assert.equal(controller.snapshot.transactionOpen, false);
  assert.equal(controller.snapshot.commitMayHaveReachedDevice, false);
  assert.equal(exported.configuration_generation, 7);
  assert.equal(exported.configuration_crc32, "89ABCDEF");
  assert.deepEqual(exported, controller.exportVerifiedMapping());
  assert.deepEqual(
    reconnected.calls.map(([method]) => method),
    ["info", "getConfiguration", "begin", "scan", "abort"],
  );
});

test("a pre-commit staging failure aborts safely and never sends CFG COMMIT", async () => {
  const client = clientReadyForIdentification({
    scans: [...identificationScans(), scan(ROMS)],
    failures: { setProbe: new Error("write failed") },
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);

  await assert.rejects(controller.commit(), /write failed/);
  assert.equal(controller.snapshot.phase, CommissioningPhase.FAILED);
  assert.equal(controller.snapshot.transactionOpen, false);
  assert.equal(client.calls.some(([method]) => method === "abort"), true);
  assert.equal(client.calls.some(([method]) => method === "commit"), false);
});

test("a lost commit acknowledgement is indeterminate and is never auto-aborted", async () => {
  const client = clientReadyForIdentification({
    scans: [...identificationScans(), scan(ROMS)],
    failures: { commit: new Error("USB disconnected") },
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);

  await assert.rejects(
    controller.commit(),
    (error) => error instanceof CommitOutcomeUnknownError,
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(controller.snapshot.commitMayHaveReachedDevice, true);
  assert.equal(client.calls.some(([method]) => method === "abort"), false);
});

test("an unknown commit can complete only after boot and live-bus verification", async () => {
  const client = clientReadyForIdentification({
    scans: [...identificationScans(), scan(ROMS)],
    failures: { commit: new Error("USB disconnected") },
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  await assert.rejects(controller.commit(), CommitOutcomeUnknownError);

  const active = configuration(ROMS, {
    generation: 8,
    crc32: "76543210",
  });
  const reconnected = new FakeClient({
    infos: [deviceInfo({ configured: true, activeGeneration: 8 })],
    configurations: [active],
    scans: [scan(ROMS, { mapped: true })],
  });
  const document = await controller.verifyRecoveredAfterReconnect(reconnected);

  assert.equal(document.configuration_generation, 8);
  assert.equal(controller.snapshot.phase, CommissioningPhase.COMPLETE);
  assert.equal(controller.snapshot.transactionOpen, false);
  assert.equal(controller.snapshot.commitMayHaveReachedDevice, false);
  assert.deepEqual(
    reconnected.calls.map(([method]) => method),
    ["info", "getConfiguration", "begin", "scan", "abort"],
  );
});

test("a complete saved map can finish verification after a page reload", async () => {
  const active = configuration(ROMS, {
    generation: 9,
    crc32: "13579BDF",
  });
  const info = deviceInfo({ configured: true, activeGeneration: 9 });
  const client = new FakeClient({
    infos: [info, info],
    configurations: [active, active],
    scans: [scan([...ROMS].reverse(), { mapped: true })],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  const pending = {
    ...buildMappingDocument(ROMS),
    portal_phase: CommissioningPhase.RECOVERY_REQUIRED,
    commit_outcome: "unknown",
  };
  const document = await controller.verifyPendingAfterInspect(pending);

  assert.equal(controller.snapshot.phase, CommissioningPhase.COMPLETE);
  assert.equal(controller.snapshot.transactionOpen, false);
  assert.deepEqual(controller.snapshot.mappedRoms, ROMS);
  assert.equal(document.configuration_generation, 9);
  assert.equal(document.configuration_crc32, "13579BDF");
  assert.deepEqual(
    client.calls.map(([method]) => method),
    [
      "info",
      "getConfiguration",
      "info",
      "getConfiguration",
      "begin",
      "scan",
      "abort",
    ],
  );
});

test("saved-map reload recovery rechecks identity before opening a scan transaction", async () => {
  const active = configuration(ROMS, {
    generation: 9,
    crc32: "13579BDF",
  });
  const changed = [...ROMS];
  [changed[0], changed[1]] = [changed[1], changed[0]];
  const client = new FakeClient({
    infos: [
      deviceInfo({ configured: true, activeGeneration: 9 }),
      deviceInfo({ configured: true, activeGeneration: 10 }),
    ],
    configurations: [
      active,
      configuration(changed, { generation: 10, crc32: "2468ACE0" }),
    ],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  await assert.rejects(
    controller.verifyPendingAfterInspect({
      ...buildMappingDocument(ROMS),
      commit_generation: 9,
      commit_crc32: "13579BDF",
    }),
    (error) => error.code === "pending-mapping-mismatch",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.READY);
  assert.equal(client.calls.some(([method]) => method === "begin"), false);
  assert.equal(client.calls.some(([method]) => method === "scan"), false);
});

test("saved-map reload recovery requires restart before any diagnostic transaction", async () => {
  const active = configuration(ROMS, {
    generation: 9,
    crc32: "13579BDF",
    restartRequired: true,
  });
  const client = new FakeClient({
    infos: [
      deviceInfo({
        configured: true,
        activeGeneration: 8,
        restartRequired: true,
      }),
    ],
    configurations: [active],
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  await assert.rejects(
    controller.verifyPendingAfterInspect(buildMappingDocument(ROMS)),
    (error) => error.code === "invalid-transition",
  );
  assert.equal(client.calls.some(([method]) => method === "begin"), false);
});

test("saved-map verification exposes an uncleared diagnostic transaction", async () => {
  const active = configuration(ROMS, {
    generation: 9,
    crc32: "13579BDF",
  });
  const info = deviceInfo({ configured: true, activeGeneration: 9 });
  const client = new FakeClient({
    infos: [info, info],
    configurations: [active, active],
    scans: [scan(ROMS, { mapped: true })],
    failures: {
      abort: [
        new Error("abort acknowledgement lost"),
        new Error("abort retry acknowledgement lost"),
      ],
    },
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();

  await assert.rejects(
    controller.verifyPendingAfterInspect(buildMappingDocument(ROMS)),
    (error) => error.code === "verification-abort-failed",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(controller.snapshot.transactionOpen, true);
});

test("recovered verification checks the active generation before CFG BEGIN", async () => {
  const client = clientReadyForIdentification({
    scans: [...identificationScans(), scan(ROMS)],
    failures: { commit: new Error("USB disconnected") },
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  await assert.rejects(controller.commit(), CommitOutcomeUnknownError);

  const reconnected = new FakeClient({
    infos: [deviceInfo({ configured: true, activeGeneration: 7 })],
    configurations: [
      configuration(ROMS, {
        generation: 8,
        crc32: "76543210",
      }),
    ],
  });
  await assert.rejects(
    controller.verifyRecoveredAfterReconnect(reconnected),
    /activated configuration generation 7, expected 8/,
  );
  assert.deepEqual(
    reconnected.calls.map(([method]) => method),
    ["info", "getConfiguration"],
  );
});

test("mismatched post-commit readback becomes indeterminate", async () => {
  const reordered = [...ROMS];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  const client = clientReadyForIdentification({
    configurations: [
      configuration(),
      configuration(reordered, {
        generation: 7,
        crc32: "89ABCDEF",
        restartRequired: true,
      }),
    ],
    scans: [...identificationScans(), scan(ROMS)],
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);

  await assert.rejects(
    controller.commit(),
    (error) => error instanceof CommitOutcomeUnknownError,
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(client.calls.some(([method]) => method === "abort"), false);
});

test("post-reboot generation mismatch does not open a diagnostic transaction", async () => {
  const committed = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  const client = clientReadyForIdentification({
    configurations: [configuration(), committed],
    scans: [...identificationScans(), scan(ROMS)],
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  await controller.commit();
  await controller.reboot();

  const wrongDevice = new FakeClient({
    infos: [deviceInfo({ configured: true, activeGeneration: 6 })],
  });
  await assert.rejects(controller.verifyAfterReconnect(wrongDevice), /expected 7/);
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_RECONNECT);
  assert.deepEqual(wrongDevice.calls, [["info"]]);
});

test("a lost reboot acknowledgement conservatively keeps the lock status unknown", async () => {
  const committed = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  const client = clientReadyForIdentification({
    configurations: [configuration(), committed],
    scans: [...identificationScans(), scan(ROMS)],
    failures: { reboot: new Error("port disappeared") },
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  await controller.commit();

  await assert.rejects(
    controller.reboot(),
    (error) => error.code === "reboot-outcome-unknown",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_RECONNECT);
  assert.equal(controller.snapshot.transactionOpen, true);
});

test("failed post-reboot live scan is aborted and cannot produce a verified export", async () => {
  const committed = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  const client = clientReadyForIdentification({
    configurations: [configuration(), committed],
    scans: [...identificationScans(), scan(ROMS)],
  });
  const controller = new ConnectCommissioningController(client);
  await identifyAll(controller);
  await controller.commit();
  await controller.reboot();

  const active = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
  });
  const reconnected = new FakeClient({
    infos: [deviceInfo({ configured: true, activeGeneration: 7 })],
    configurations: [active],
    scans: [scan(ROMS.slice(0, 7), { mapped: true })],
  });
  await assert.rejects(
    controller.verifyAfterReconnect(reconnected),
    (error) => error.code === "probe-set-mismatch",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.AWAITING_RECONNECT);
  assert.equal(reconnected.calls.some(([method]) => method === "abort"), true);
  assert.throws(
    () => controller.exportVerifiedMapping(),
    (error) => error.code === "invalid-transition",
  );
});

test("keepalive failure exposes a recovery-required lock state", async () => {
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    failures: { keepalive: new Error("timeout") },
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start();

  await assert.rejects(
    controller.keepalive(),
    (error) =>
      error instanceof CommissioningWorkflowError &&
      error.code === "keepalive-failed",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(controller.snapshot.transactionOpen, true);

  await controller.abort();
  assert.equal(controller.snapshot.phase, CommissioningPhase.ABORTED);
});

test("an abort that still requires restart never reports a safe idle state", async () => {
  const client = new FakeClient({
    infos: [deviceInfo()],
    configurations: [configuration()],
    abortResult: { restartRequired: true },
  });
  const controller = new ConnectCommissioningController(client);
  await controller.inspect();
  await controller.start();

  await assert.rejects(
    controller.abort(),
    (error) => error.code === "abort-restart-required",
  );
  assert.equal(controller.snapshot.phase, CommissioningPhase.RECOVERY_REQUIRED);
  assert.equal(controller.snapshot.transactionOpen, true);
});

test("verification helpers reject commit and active-state identity mismatches", () => {
  const staged = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
    restartRequired: true,
  });
  assert.throws(
    () =>
      verifyCommittedReadback(staged, ROMS, {
        generation: 8,
        crc32: "89ABCDEF",
        rebootRequired: true,
      }),
    (error) => error.code === "commit-ack-mismatch",
  );

  const active = configuration(ROMS, {
    generation: 7,
    crc32: "89ABCDEF",
  });
  assert.throws(
    () =>
      verifyPostRebootState(
        deviceInfo({ configured: true, activeGeneration: 7 }),
        active,
        scan(ROMS, { mapped: false }),
        staged,
        ROMS,
      ),
    (error) => error.code === "mapped-position-mismatch",
  );
});
