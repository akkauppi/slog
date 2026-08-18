import {
  EXPECTED_SENSORS,
  GEOMETRY_ID,
  normalizeRom,
  oneAddedRom,
  requireActiveGeneration,
  requireCompatibleDevice,
  selectWarmedProbe,
  strongestWarming,
  validateMapping,
} from "./protocol.js";

export const MAPPING_SCHEMA_VERSION = 1;
export const DEFAULT_MAPPING_DEVICE = "sauna-column-1";
export const WARM_BASELINE_SCAN_COUNT = 5;
export const WARM_BASELINE_MAX_SPAN_C = 0.5;

export const CommissioningMethod = Object.freeze({
  CONNECT: "connect",
  WARM: "warm",
});

export const CommissioningPhase = Object.freeze({
  IDLE: "idle",
  INSPECTING: "inspecting",
  READY: "ready",
  STARTING: "starting",
  AWAITING_EMPTY_BUS: "awaiting-empty-bus",
  SCANNING_EMPTY_BUS: "scanning-empty-bus",
  IDENTIFYING: "identifying",
  SCANNING_PROBE: "scanning-probe",
  AWAITING_WARM_BASELINE: "awaiting-warm-baseline",
  LEARNING_WARM_BASELINE: "learning-warm-baseline",
  IDENTIFYING_WARM: "identifying-warm",
  SCANNING_WARM_PROBE: "scanning-warm-probe",
  READY_TO_COMMIT: "ready-to-commit",
  COMMITTING: "committing",
  READY_TO_REBOOT: "ready-to-reboot",
  REBOOTING: "rebooting",
  AWAITING_RECONNECT: "awaiting-reconnect",
  VERIFYING: "verifying",
  COMPLETE: "complete",
  ABORTING: "aborting",
  ABORTED: "aborted",
  RECOVERY_REQUIRED: "recovery-required",
  FAILED: "failed",
});

const CRC32_TEXT = /^[0-9A-F]{8}$/;
const TRANSACTION_PHASES = new Set([
  CommissioningPhase.AWAITING_EMPTY_BUS,
  CommissioningPhase.SCANNING_EMPTY_BUS,
  CommissioningPhase.IDENTIFYING,
  CommissioningPhase.SCANNING_PROBE,
  CommissioningPhase.AWAITING_WARM_BASELINE,
  CommissioningPhase.LEARNING_WARM_BASELINE,
  CommissioningPhase.IDENTIFYING_WARM,
  CommissioningPhase.SCANNING_WARM_PROBE,
  CommissioningPhase.READY_TO_COMMIT,
]);

export class CommissioningWorkflowError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CommissioningWorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? true;
  }
}

export class CommitOutcomeUnknownError extends CommissioningWorkflowError {
  constructor(message, options = {}) {
    super("commit-outcome-unknown", message, {
      ...options,
      recoverable: false,
    });
    this.name = "CommitOutcomeUnknownError";
  }
}

export class RebootOutcomeUnknownError extends CommissioningWorkflowError {
  constructor(message, options = {}) {
    super("reboot-outcome-unknown", message, options);
    this.name = "RebootOutcomeUnknownError";
  }
}

function fail(code, message, options) {
  throw new CommissioningWorkflowError(code, message, options);
}

function copyData(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

function canonicalPartialMapping(roms) {
  if (!Array.isArray(roms)) {
    fail("invalid-draft", "The probe mapping must be an array.");
  }
  if (roms.length > EXPECTED_SENSORS) {
    fail(
      "invalid-draft",
      `A mapping can contain at most ${EXPECTED_SENSORS} probes.`,
    );
  }

  const canonical = roms.map((rom) => normalizeRom(rom));
  if (new Set(canonical).size !== canonical.length) {
    fail("duplicate-probe", "The probe mapping contains a duplicate ROM address.");
  }
  return canonical;
}

function requireInteger(value, field, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail("invalid-mapping-document", `${field} is not a valid integer.`);
  }
  return value;
}

function configurationRoms(configuration) {
  if (!configuration || configuration.state !== "valid") {
    fail("invalid-readback", "The logger did not return a valid configuration.");
  }
  if (configuration.geometry !== GEOMETRY_ID) {
    fail(
      "invalid-readback",
      `The logger returned unsupported geometry ${String(configuration.geometry)}.`,
    );
  }
  if (!Array.isArray(configuration.probes)) {
    fail("invalid-readback", "The logger configuration has no ordered probe map.");
  }

  const roms = configuration.probes.map((probe, index) => {
    if (probe.position !== index + 1) {
      fail(
        "invalid-readback",
        "The logger configuration positions are missing, duplicated, or unordered.",
      );
    }
    return normalizeRom(probe.rom);
  });
  return validateMapping(roms);
}

function normalizedConfigurationIdentity(configuration) {
  const generation = requireInteger(configuration.generation, "generation", 1);
  const crc32 = String(configuration.crc32 ?? "").toUpperCase();
  if (!CRC32_TEXT.test(crc32)) {
    fail("invalid-readback", "The logger returned an invalid configuration CRC32.");
  }
  return { generation, crc32 };
}

function scanRoms(scan, { requireTemperatures = true } = {}) {
  if (!scan || !Array.isArray(scan.probes)) {
    fail("invalid-scan", "The logger returned an invalid probe scan.");
  }
  if (scan.overflow) {
    fail("scan-overflow", "The 1-Wire scan overflowed; the result is incomplete.");
  }
  if (!Number.isInteger(scan.busCount) || scan.busCount < scan.probes.length) {
    fail("invalid-scan", "The scan contains an invalid 1-Wire bus count.");
  }

  const roms = scan.probes.map((probe) => {
    const rom = normalizeRom(probe.rom);
    if (
      requireTemperatures &&
      (typeof probe.temperatureC !== "number" || !Number.isFinite(probe.temperatureC))
    ) {
      fail("missing-temperature", `Probe ${rom} has no valid temperature reading.`);
    }
    return rom;
  });
  if (new Set(roms).size !== roms.length) {
    fail("invalid-scan", "The scan contains a duplicate probe ROM address.");
  }
  return roms;
}

function completeTemperatureMap(scan, expectedRoms = null) {
  const actualRoms = scanRoms(scan);
  if (scan.busCount !== EXPECTED_SENSORS || actualRoms.length !== EXPECTED_SENSORS) {
    fail(
      "probe-set-mismatch",
      `Expected ${EXPECTED_SENSORS} valid probes on the 1-Wire bus, found ${actualRoms.length} valid of ${scan.busCount}.`,
    );
  }

  if (expectedRoms !== null) {
    const expected = validateMapping(expectedRoms);
    if (
      actualRoms.some((rom) => !expected.includes(rom)) ||
      expected.some((rom) => !actualRoms.includes(rom))
    ) {
      fail(
        "probe-set-mismatch",
        "The discovered probe set changed during warm identification.",
      );
    }
  }

  return Object.freeze(
    Object.fromEntries(
      scan.probes.map((probe) => [normalizeRom(probe.rom), probe.temperatureC]),
    ),
  );
}

function canonicalWarmBaseline(baselines) {
  if (!baselines || typeof baselines !== "object" || Array.isArray(baselines)) {
    fail("invalid-warm-baseline", "The warm-identification baseline is invalid.");
  }

  const entries = Object.entries(baselines).map(([value, temperatureC]) => {
    const rom = normalizeRom(value);
    if (typeof temperatureC !== "number" || !Number.isFinite(temperatureC)) {
      fail(
        "invalid-warm-baseline",
        `Probe ${rom} has no valid baseline temperature.`,
      );
    }
    return [rom, temperatureC];
  });
  const roms = validateMapping(entries.map(([rom]) => rom));
  if (new Set(roms).size !== entries.length) {
    fail("invalid-warm-baseline", "The warm baseline contains duplicate probes.");
  }
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Build an ambient baseline from exactly five complete, stable bus scans.
 *
 * The median is calculated independently for each ROM. Discovery order is
 * deliberately irrelevant; every scan must contain the exact same eight ROMs
 * and every probe must stay within the stability span.
 */
export function buildWarmBaseline(scans) {
  if (!Array.isArray(scans) || scans.length !== WARM_BASELINE_SCAN_COUNT) {
    fail(
      "invalid-baseline-scan-count",
      `Warm identification requires exactly ${WARM_BASELINE_SCAN_COUNT} baseline scans.`,
    );
  }

  const first = completeTemperatureMap(scans[0]);
  const expectedRoms = Object.keys(first);
  const history = Object.fromEntries(expectedRoms.map((rom) => [rom, []]));
  for (const scan of scans) {
    const temperatures = completeTemperatureMap(scan, expectedRoms);
    for (const rom of expectedRoms) history[rom].push(temperatures[rom]);
  }

  const baselines = {};
  for (const rom of expectedRoms) {
    const values = [...history[rom]].sort((left, right) => left - right);
    const spanC = values.at(-1) - values[0];
    if (spanC > WARM_BASELINE_MAX_SPAN_C) {
      fail(
        "unstable-warm-baseline",
        `Probe ${rom} changed by ${spanC.toFixed(2)} C while learning the ambient baseline.`,
      );
    }
    baselines[rom] = values[Math.floor(values.length / 2)];
  }
  return Object.freeze(baselines);
}

/** Validate a live warm scan and report both the strongest and accepted probe. */
export function evaluateWarmScan(scan, baselines, alreadyMapped = []) {
  const baseline = canonicalWarmBaseline(baselines);
  const mapped = canonicalPartialMapping(alreadyMapped);
  for (const rom of mapped) {
    if (!Object.hasOwn(baseline, rom)) {
      fail(
        "probe-set-mismatch",
        `Mapped probe ${rom} is not present in the warm baseline.`,
      );
    }
  }

  const temperatures = completeTemperatureMap(scan, Object.keys(baseline));
  const candidate = strongestWarming(temperatures, baseline, mapped);
  const accepted = selectWarmedProbe(temperatures, baseline, mapped);
  return Object.freeze({ temperatures, candidate, accepted });
}

function requireExactScan(scan, expectedRoms, { checkMappedPositions = false } = {}) {
  const expected = validateMapping(expectedRoms);
  const actual = scanRoms(scan);
  if (scan.busCount !== EXPECTED_SENSORS) {
    fail(
      "probe-set-mismatch",
      `Expected ${EXPECTED_SENSORS} devices on the 1-Wire bus, found ${scan.busCount}.`,
    );
  }
  if (
    actual.length !== expected.length ||
    actual.some((rom) => !expected.includes(rom))
  ) {
    fail(
      "probe-set-mismatch",
      "The discovered probe set does not exactly match the proposed mapping.",
    );
  }

  if (checkMappedPositions) {
    const positions = new Map(expected.map((rom, index) => [rom, index + 1]));
    for (const probe of scan.probes) {
      const expectedPosition = positions.get(normalizeRom(probe.rom));
      if (
        probe.mappedPosition !== undefined &&
        probe.mappedPosition !== expectedPosition
      ) {
        fail(
          "mapped-position-mismatch",
          `Probe ${normalizeRom(probe.rom)} is mapped to an unexpected position.`,
        );
      }
    }
  }
  return actual;
}

function requireClearedAbort(result) {
  if (!result || result.restartRequired !== false) {
    fail(
      "abort-restart-required",
      "The logger could not resume safely without a reboot.",
      { recoverable: false },
    );
  }
}

/** Build the browser draft and sensor-map.json interchange shape. */
export function buildMappingDocument(
  roms,
  configuration = null,
  { device = DEFAULT_MAPPING_DEVICE } = {},
) {
  const canonical = canonicalPartialMapping(roms);
  if (configuration !== null) {
    validateMapping(canonical);
  }
  if (typeof device !== "string" || device.length === 0) {
    fail("invalid-draft", "The mapping device name must be a non-empty string.");
  }

  const document = {
    schema_version: MAPPING_SCHEMA_VERSION,
    device,
    one_wire_pin: "D2",
    geometry: GEOMETRY_ID,
    reference_end: "opposite_esp32",
    position_direction: "toward_esp32",
    installation_order: "top_to_bottom",
    spacing_cm: 20,
    height_reference: "probe_1",
    sensors: canonical.map((rom, index) => ({
      position_from_reference_end: index + 1,
      relative_height_cm: index === 0 ? 0 : index * -20,
      rom,
    })),
  };

  if (configuration !== null) {
    const identity = normalizedConfigurationIdentity(configuration);
    document.configuration_generation = identity.generation;
    document.configuration_crc32 = identity.crc32;
  }
  return document;
}

/** Strictly load a draft while allowing future additive top-level fields. */
export function parseMappingDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("invalid-mapping-document", "The mapping document must be an object.");
  }
  if (document.schema_version !== MAPPING_SCHEMA_VERSION) {
    fail("invalid-mapping-document", "The mapping document schema is not supported.");
  }
  if (
    document.geometry !== GEOMETRY_ID ||
    document.one_wire_pin !== "D2" ||
    document.reference_end !== "opposite_esp32" ||
    document.position_direction !== "toward_esp32" ||
    document.installation_order !== "top_to_bottom" ||
    document.height_reference !== "probe_1" ||
    document.spacing_cm !== 20
  ) {
    fail("invalid-mapping-document", "The mapping document geometry is incompatible.");
  }
  if (typeof document.device !== "string" || document.device.length === 0) {
    fail("invalid-mapping-document", "The mapping document device name is invalid.");
  }
  if (!Array.isArray(document.sensors)) {
    fail("invalid-mapping-document", "The mapping document has no sensors array.");
  }

  const roms = document.sensors.map((sensor, index) => {
    if (
      !sensor ||
      sensor.position_from_reference_end !== index + 1 ||
      sensor.relative_height_cm !== index * -20
    ) {
      fail(
        "invalid-mapping-document",
        "The mapping document sensor positions are not ordered P1 through P8.",
      );
    }
    return sensor.rom;
  });
  const canonical = canonicalPartialMapping(roms);

  const hasGeneration = document.configuration_generation !== undefined;
  const hasCrc = document.configuration_crc32 !== undefined;
  if (hasGeneration !== hasCrc) {
    fail(
      "invalid-mapping-document",
      "A verified mapping must contain both generation and CRC32.",
    );
  }

  let configuration = null;
  if (hasGeneration) {
    validateMapping(canonical);
    configuration = {
      generation: requireInteger(
        document.configuration_generation,
        "configuration_generation",
        1,
      ),
      crc32: String(document.configuration_crc32).toUpperCase(),
    };
    if (!CRC32_TEXT.test(configuration.crc32)) {
      fail("invalid-mapping-document", "The mapping document CRC32 is invalid.");
    }
  }
  return { roms: canonical, configuration };
}

export function serializeMappingDocument(document) {
  parseMappingDocument(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Return the complete ordered map from a saved browser draft only when it is
 * identical to the boot-selected configuration. Optional commit identity
 * fields are treated as additional constraints, never as substitutes for the
 * ordered ROM comparison.
 */
export function matchPendingMapping(document, configuration) {
  try {
    const parsed = parseMappingDocument(document);
    const expected = validateMapping(parsed.roms);
    const actual = configurationRoms(configuration);
    if (actual.some((rom, index) => rom !== expected[index])) return null;

    const activeIdentity = normalizedConfigurationIdentity(configuration);
    const identities = [];
    if (parsed.configuration) identities.push(parsed.configuration);

    const hasCommitGeneration = document.commit_generation !== undefined;
    const hasCommitCrc = document.commit_crc32 !== undefined;
    if (hasCommitGeneration !== hasCommitCrc) return null;
    if (hasCommitGeneration) {
      const generation = requireInteger(
        document.commit_generation,
        "commit_generation",
        1,
      );
      const crc32 = String(document.commit_crc32).toUpperCase();
      if (!CRC32_TEXT.test(crc32)) return null;
      identities.push({ generation, crc32 });
    }

    if (
      identities.some(
        ({ generation, crc32 }) =>
          generation !== activeIdentity.generation || crc32 !== activeIdentity.crc32,
      )
    ) {
      return null;
    }
    return Object.freeze({
      roms: Object.freeze([...expected]),
      generation: activeIdentity.generation,
      crc32: activeIdentity.crc32,
    });
  } catch {
    return null;
  }
}

/** Verify the complete CFG COMMIT acknowledgement and CFG GET readback. */
export function verifyCommittedReadback(configuration, expectedRoms, commitResult) {
  const expected = validateMapping(expectedRoms);
  const actual = configurationRoms(configuration);
  if (actual.some((rom, index) => rom !== expected[index])) {
    fail(
      "readback-mismatch",
      "The committed mapping does not match the ordered CFG GET readback.",
      { recoverable: false },
    );
  }

  const identity = normalizedConfigurationIdentity(configuration);
  if (configuration.restartRequired !== true) {
    fail(
      "readback-mismatch",
      "The committed configuration did not report that a reboot is required.",
      { recoverable: false },
    );
  }
  if (!commitResult || commitResult.rebootRequired !== true) {
    fail(
      "commit-ack-mismatch",
      "CFG COMMIT did not return the required reboot acknowledgement.",
      { recoverable: false },
    );
  }
  const acknowledgedCrc = String(commitResult.crc32 ?? "").toUpperCase();
  if (
    commitResult.generation !== identity.generation ||
    acknowledgedCrc !== identity.crc32
  ) {
    fail(
      "commit-ack-mismatch",
      "CFG COMMIT and CFG GET identify different configurations.",
      { recoverable: false },
    );
  }
  return copyData(configuration);
}

/** Verify the device identity, activated map, and live bus after reboot. */
export function verifyPostRebootState(
  info,
  configuration,
  scan,
  expectedConfiguration,
  expectedRoms,
) {
  requireCompatibleDevice(info);
  const expected = validateMapping(expectedRoms);
  const expectedIdentity = normalizedConfigurationIdentity(expectedConfiguration);
  requireActiveGeneration(info, expectedIdentity.generation);

  const actual = configurationRoms(configuration);
  const actualIdentity = normalizedConfigurationIdentity(configuration);
  if (configuration.restartRequired !== false) {
    fail(
      "activation-mismatch",
      "The logger still reports that configuration activation requires a reboot.",
    );
  }
  if (
    actualIdentity.generation !== expectedIdentity.generation ||
    actualIdentity.crc32 !== expectedIdentity.crc32 ||
    actual.some((rom, index) => rom !== expected[index])
  ) {
    fail(
      "activation-mismatch",
      "The rebooted logger does not match the committed configuration.",
    );
  }
  requireExactScan(scan, expected, { checkMappedPositions: true });
  return buildMappingDocument(expected, configuration);
}

function requirePhase(actual, expected, action) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    fail(
      "invalid-transition",
      `Cannot ${action} while commissioning is in the ${actual} phase.`,
    );
  }
}

function errorSummary(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "unexpected-error",
    message: error?.message ?? String(error),
  };
}

function requireCommissioningMethod(method) {
  if (!Object.values(CommissioningMethod).includes(method)) {
    fail(
      "invalid-commissioning-method",
      `Unsupported probe-identification method ${String(method)}.`,
    );
  }
  return method;
}

/**
 * DOM-free connect-or-warm commissioning controller.
 *
 * The injected client mirrors the Python client: info(), getConfiguration(),
 * begin(), scan(), setProbe(), commit(), abort(), keepalive(), and reboot().
 */
export class ConnectCommissioningController {
  constructor(client) {
    if (!client) {
      fail("missing-client", "A commissioning protocol client is required.");
    }
    this.client = client;
    this.phase = CommissioningPhase.IDLE;
    this.method = CommissioningMethod.CONNECT;
    this.deviceInfo = null;
    this.existingConfiguration = null;
    this.mappedRoms = [];
    this.warmBaseline = null;
    this.lastScan = null;
    this.committedConfiguration = null;
    this.lastError = null;
    this.transactionOpen = false;
    this.commitMayHaveReachedDevice = false;
  }

  setClient(client) {
    if (!client) {
      fail("missing-client", "A commissioning protocol client is required.");
    }
    this.client = client;
  }

  get snapshot() {
    return {
      phase: this.phase,
      method: this.method,
      deviceInfo: copyData(this.deviceInfo),
      existingConfiguration: copyData(this.existingConfiguration),
      mappedRoms: [...this.mappedRoms],
      warmBaseline: copyData(this.warmBaseline),
      nextPosition:
        this.mappedRoms.length < EXPECTED_SENSORS
          ? this.mappedRoms.length + 1
          : null,
      lastScan: copyData(this.lastScan),
      committedConfiguration: copyData(this.committedConfiguration),
      transactionOpen: this.transactionOpen,
      commitMayHaveReachedDevice: this.commitMayHaveReachedDevice,
      lastError: copyData(this.lastError),
      draft: buildMappingDocument(this.mappedRoms),
    };
  }

  _clearError() {
    this.lastError = null;
  }

  _rememberError(error) {
    this.lastError = errorSummary(error);
  }

  async inspect() {
    requirePhase(
      this.phase,
      [
        CommissioningPhase.IDLE,
        CommissioningPhase.READY,
        CommissioningPhase.ABORTED,
        CommissioningPhase.FAILED,
      ],
      "inspect the logger",
    );
    this.phase = CommissioningPhase.INSPECTING;
    this._clearError();
    try {
      const info = await this.client.info();
      requireCompatibleDevice(info);
      const configuration = await this.client.getConfiguration();
      if (configuration.restartRequired !== info.restartRequired) {
        fail(
          "configuration-state-mismatch",
          "SYS INFO and CFG GET disagree about whether a restart is required.",
        );
      }
      if (!info.restartRequired && info.configured !== (configuration.state === "valid")) {
        fail(
          "configuration-state-mismatch",
          "SYS INFO and CFG GET disagree about the active probe configuration.",
        );
      }
      if (configuration.state === "valid") {
        configurationRoms(configuration);
        const identity = normalizedConfigurationIdentity(configuration);
        if (!info.restartRequired && info.activeGeneration !== identity.generation) {
          fail(
            "configuration-state-mismatch",
            "SYS INFO and CFG GET identify different active generations.",
          );
        }
      }
      this.deviceInfo = copyData(info);
      this.existingConfiguration = copyData(configuration);
      this.transactionOpen = info.commissioning;
      this.phase = info.restartRequired || info.commissioning
        ? CommissioningPhase.RECOVERY_REQUIRED
        : CommissioningPhase.READY;
      return this.snapshot;
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.FAILED;
      throw error;
    }
  }

  async start({ replaceExisting = false, method = CommissioningMethod.CONNECT } = {}) {
    requirePhase(this.phase, CommissioningPhase.READY, "start commissioning");
    requireCommissioningMethod(method);
    if (this.existingConfiguration?.state === "valid" && !replaceExisting) {
      fail(
        "replacement-not-confirmed",
        "The logger already has a valid mapping; replacement was not confirmed.",
      );
    }

    this.phase = CommissioningPhase.STARTING;
    this._clearError();
    try {
      if (this.deviceInfo?.commissioning) {
        const result = await this.client.abort();
        requireClearedAbort(result);
      }
      await this.client.begin(GEOMETRY_ID);
      this.transactionOpen = true;
      this.method = method;
      this.mappedRoms = [];
      this.warmBaseline = null;
      this.lastScan = null;
      this.committedConfiguration = null;
      this.commitMayHaveReachedDevice = false;
      this.phase =
        method === CommissioningMethod.WARM
          ? CommissioningPhase.AWAITING_WARM_BASELINE
          : CommissioningPhase.AWAITING_EMPTY_BUS;
      return this.snapshot;
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.FAILED;
      throw error;
    }
  }

  async confirmEmptyBus() {
    requirePhase(
      this.phase,
      CommissioningPhase.AWAITING_EMPTY_BUS,
      "check the empty probe bus",
    );
    this.phase = CommissioningPhase.SCANNING_EMPTY_BUS;
    this._clearError();
    try {
      const scan = await this.client.scan();
      const roms = scanRoms(scan, { requireTemperatures: false });
      this.lastScan = copyData(scan);
      if (roms.length !== 0 || scan.busCount !== 0) {
        fail(
          "bus-not-empty",
          "Disconnect every probe before beginning position identification.",
        );
      }
      this.phase = CommissioningPhase.IDENTIFYING;
      return this.snapshot;
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.AWAITING_EMPTY_BUS;
      throw error;
    }
  }

  async identifyNextProbe() {
    requirePhase(
      this.phase,
      CommissioningPhase.IDENTIFYING,
      "identify the next probe",
    );
    if (this.mappedRoms.length >= EXPECTED_SENSORS) {
      fail("mapping-complete", "All probe positions have already been identified.");
    }

    this.phase = CommissioningPhase.SCANNING_PROBE;
    this._clearError();
    try {
      const scan = await this.client.scan();
      const currentRoms = scanRoms(scan);
      const rom = oneAddedRom(this.mappedRoms, currentRoms);
      this.mappedRoms.push(rom);
      this.lastScan = copyData(scan);
      this.phase =
        this.mappedRoms.length === EXPECTED_SENSORS
          ? CommissioningPhase.READY_TO_COMMIT
          : CommissioningPhase.IDENTIFYING;
      const reading = scan.probes.find(
        (probe) => normalizeRom(probe.rom) === rom,
      );
      return {
        position: this.mappedRoms.length,
        rom,
        temperatureC: reading.temperatureC,
        draft: this.exportDraft(),
      };
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.IDENTIFYING;
      throw error;
    }
  }

  async captureWarmBaseline() {
    requirePhase(
      this.phase,
      CommissioningPhase.AWAITING_WARM_BASELINE,
      "learn the warm-identification baseline",
    );
    this.phase = CommissioningPhase.LEARNING_WARM_BASELINE;
    this._clearError();
    try {
      const scans = [];
      let expectedRoms = null;
      for (let index = 0; index < WARM_BASELINE_SCAN_COUNT; index += 1) {
        const scan = await this.client.scan();
        const temperatures = completeTemperatureMap(scan, expectedRoms);
        expectedRoms ??= Object.keys(temperatures);
        scans.push(scan);
      }
      this.warmBaseline = buildWarmBaseline(scans);
      this.lastScan = copyData(scans.at(-1));
      this.phase = CommissioningPhase.IDENTIFYING_WARM;
      return this.snapshot;
    } catch (error) {
      this.warmBaseline = null;
      this._rememberError(error);
      this.phase = CommissioningPhase.AWAITING_WARM_BASELINE;
      throw error;
    }
  }

  async identifyNextWarmedProbe() {
    requirePhase(
      this.phase,
      CommissioningPhase.IDENTIFYING_WARM,
      "identify the next warmed probe",
    );
    if (!this.warmBaseline) {
      fail(
        "missing-warm-baseline",
        "Learn a complete ambient baseline before warming a probe.",
      );
    }
    if (this.mappedRoms.length >= EXPECTED_SENSORS) {
      fail("mapping-complete", "All probe positions have already been identified.");
    }

    this.phase = CommissioningPhase.SCANNING_WARM_PROBE;
    this._clearError();
    try {
      const scans = [await this.client.scan(), await this.client.scan()];
      const outcomes = scans.map((scan) =>
        evaluateWarmScan(scan, this.warmBaseline, this.mappedRoms),
      );
      this.lastScan = copyData(scans.at(-1));

      const [first, second] = outcomes.map(({ accepted }) => accepted);
      if (!first || !second || first.rom !== second.rom) {
        this.phase = CommissioningPhase.IDENTIFYING_WARM;
        return {
          position: this.mappedRoms.length + 1,
          accepted: null,
          candidates: outcomes.map(({ candidate }) => copyData(candidate)),
          draft: this.exportDraft(),
        };
      }

      this.mappedRoms.push(second.rom);
      this.phase =
        this.mappedRoms.length === EXPECTED_SENSORS
          ? CommissioningPhase.READY_TO_COMMIT
          : CommissioningPhase.IDENTIFYING_WARM;
      return {
        position: this.mappedRoms.length,
        accepted: copyData(second),
        candidates: outcomes.map(({ candidate }) => copyData(candidate)),
        draft: this.exportDraft(),
      };
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.IDENTIFYING_WARM;
      throw error;
    }
  }

  async keepalive() {
    requirePhase(this.phase, [...TRANSACTION_PHASES], "keep commissioning alive");
    try {
      await this.client.keepalive();
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      throw new CommissioningWorkflowError(
        "keepalive-failed",
        "The commissioning keepalive failed; do not assume that logging is active.",
        { cause: error },
      );
    }
  }

  async abort() {
    requirePhase(
      this.phase,
      [...TRANSACTION_PHASES, CommissioningPhase.RECOVERY_REQUIRED],
      "abort commissioning",
    );
    if (!this.transactionOpen) {
      fail("no-open-transaction", "There is no known commissioning transaction to abort.");
    }
    if (this.commitMayHaveReachedDevice) {
      fail(
        "unsafe-abort",
        "A commit may have reached the logger; reconnect and inspect it instead.",
        { recoverable: false },
      );
    }
    this.phase = CommissioningPhase.ABORTING;
    try {
      const result = await this.client.abort();
      requireClearedAbort(result);
      this.transactionOpen = false;
      this.phase = CommissioningPhase.ABORTED;
      return this.snapshot;
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      throw error;
    }
  }

  async _abortPreCommitFailure(originalError) {
    try {
      const result = await this.client.abort();
      requireClearedAbort(result);
      this.transactionOpen = false;
      this.phase = CommissioningPhase.FAILED;
    } catch (abortError) {
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      this._rememberError(abortError);
      throw new CommissioningWorkflowError(
        "staging-and-abort-failed",
        "Staging failed and the commissioning lock could not be cleared.",
        { cause: abortError, recoverable: false },
      );
    }
    this._rememberError(originalError);
    throw originalError;
  }

  async commit() {
    requirePhase(
      this.phase,
      CommissioningPhase.READY_TO_COMMIT,
      "commit the probe mapping",
    );
    const expected = validateMapping(this.mappedRoms);
    this.phase = CommissioningPhase.COMMITTING;
    this._clearError();

    let finalScan;
    try {
      finalScan = await this.client.scan();
      requireExactScan(finalScan, expected);
      this.lastScan = copyData(finalScan);
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.READY_TO_COMMIT;
      throw error;
    }

    try {
      for (let index = 0; index < expected.length; index += 1) {
        await this.client.setProbe(index + 1, expected[index]);
      }
    } catch (error) {
      return this._abortPreCommitFailure(error);
    }

    this.commitMayHaveReachedDevice = true;
    let commitResult;
    try {
      commitResult = await this.client.commit();
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      throw new CommitOutcomeUnknownError(
        "The commit acknowledgement was lost. Reconnect and inspect the logger; do not retry blindly.",
        { cause: error },
      );
    }

    try {
      const configuration = await this.client.getConfiguration();
      this.committedConfiguration = verifyCommittedReadback(
        configuration,
        expected,
        commitResult,
      );
      this.phase = CommissioningPhase.READY_TO_REBOOT;
      return copyData(this.committedConfiguration);
    } catch (error) {
      this._rememberError(error);
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      throw new CommitOutcomeUnknownError(
        "The stored mapping could not be verified after commit. Reconnect and inspect the logger.",
        { cause: error },
      );
    }
  }

  async reboot() {
    requirePhase(
      this.phase,
      [CommissioningPhase.READY_TO_REBOOT, CommissioningPhase.AWAITING_RECONNECT],
      "reboot the logger",
    );
    if (!this.committedConfiguration) {
      fail("missing-readback", "There is no verified committed mapping to activate.");
    }
    this.phase = CommissioningPhase.REBOOTING;
    try {
      await this.client.reboot();
      this.transactionOpen = false;
      this.phase = CommissioningPhase.AWAITING_RECONNECT;
      return this.snapshot;
    } catch (error) {
      // The acknowledgement may have been transmitted immediately before the
      // USB device disappeared. Reconnection and verification are still safe.
      this.transactionOpen = true;
      this._rememberError(error);
      this.phase = CommissioningPhase.AWAITING_RECONNECT;
      throw new RebootOutcomeUnknownError(
        "The reboot acknowledgement was lost; reconnect and verify the logger.",
        { cause: error },
      );
    }
  }

  async verifyAfterReconnect(client = this.client) {
    requirePhase(
      this.phase,
      CommissioningPhase.AWAITING_RECONNECT,
      "verify the rebooted logger",
    );
    if (!this.committedConfiguration) {
      fail("missing-readback", "There is no committed mapping to verify.");
    }
    this.setClient(client);
    this.phase = CommissioningPhase.VERIFYING;
    this._clearError();

    let diagnosticTransaction = false;
    try {
      const info = await this.client.info();
      requireCompatibleDevice(info);
      requireActiveGeneration(info, this.committedConfiguration.generation);
      const configuration = await this.client.getConfiguration();

      await this.client.begin(GEOMETRY_ID);
      diagnosticTransaction = true;
      this.transactionOpen = true;
      const scan = await this.client.scan();
      const document = verifyPostRebootState(
        info,
        configuration,
        scan,
        this.committedConfiguration,
        this.mappedRoms,
      );
      const abortResult = await this.client.abort();
      requireClearedAbort(abortResult);
      diagnosticTransaction = false;
      this.transactionOpen = false;

      this.deviceInfo = copyData(info);
      this.existingConfiguration = copyData(configuration);
      this.committedConfiguration = copyData(configuration);
      this.commitMayHaveReachedDevice = false;
      this.phase = CommissioningPhase.COMPLETE;
      return document;
    } catch (error) {
      if (diagnosticTransaction) {
        try {
          const abortResult = await this.client.abort();
          requireClearedAbort(abortResult);
          this.transactionOpen = false;
        } catch (abortError) {
          this._rememberError(abortError);
          this.phase = CommissioningPhase.RECOVERY_REQUIRED;
          throw new CommissioningWorkflowError(
            "verification-abort-failed",
            "Verification failed and its diagnostic transaction could not be cleared.",
            { cause: abortError, recoverable: false },
          );
        }
      }
      this._rememberError(error);
      this.phase = CommissioningPhase.AWAITING_RECONNECT;
      throw error;
    }
  }

  /**
   * Verify an active mapping after CFG COMMIT had no trustworthy response.
   *
   * In this recovery path there is no commit generation/CRC acknowledgement to
   * compare. The boot-selected configuration itself is accepted only when its
   * exact ordered ROM set matches the locally intended map and a diagnostic
   * live scan confirms all eight active mapped positions. The diagnostic
   * transaction must also be explicitly aborted before completion is exposed.
   */
  async verifyRecoveredAfterReconnect(client = this.client) {
    requirePhase(
      this.phase,
      CommissioningPhase.RECOVERY_REQUIRED,
      "verify a recovered commit",
    );
    const expected = validateMapping(this.mappedRoms);
    this.setClient(client);
    this.phase = CommissioningPhase.VERIFYING;
    this._clearError();

    let diagnosticTransaction = false;
    try {
      const info = await this.client.info();
      requireCompatibleDevice(info);
      if (info.restartRequired) {
        fail(
          "recovery-restart-required",
          "The logger must restart before the recovered configuration can be verified.",
        );
      }
      const configuration = await this.client.getConfiguration();
      const actual = configurationRoms(configuration);
      if (actual.some((rom, index) => rom !== expected[index])) {
        fail(
          "previous-map-active",
          "The boot-selected configuration is not the mapping that was being written.",
        );
      }
      if (configuration.restartRequired !== false) {
        fail(
          "recovery-restart-required",
          "The recovered configuration still reports that a restart is required.",
        );
      }
      requireActiveGeneration(info, configuration.generation);

      await this.client.begin(GEOMETRY_ID);
      diagnosticTransaction = true;
      this.transactionOpen = true;
      const scan = await this.client.scan();
      const document = verifyPostRebootState(
        info,
        configuration,
        scan,
        configuration,
        expected,
      );
      const abortResult = await this.client.abort();
      requireClearedAbort(abortResult);
      diagnosticTransaction = false;
      this.transactionOpen = false;

      this.deviceInfo = copyData(info);
      this.existingConfiguration = copyData(configuration);
      this.committedConfiguration = copyData(configuration);
      this.commitMayHaveReachedDevice = false;
      this.phase = CommissioningPhase.COMPLETE;
      return document;
    } catch (error) {
      if (diagnosticTransaction) {
        try {
          const abortResult = await this.client.abort();
          requireClearedAbort(abortResult);
          this.transactionOpen = false;
        } catch (abortError) {
          this._rememberError(abortError);
          this.phase = CommissioningPhase.RECOVERY_REQUIRED;
          throw new CommissioningWorkflowError(
            "verification-abort-failed",
            "Recovered verification failed and its diagnostic transaction could not be cleared.",
            { cause: abortError, recoverable: false },
          );
        }
      }
      this._rememberError(error);
      this.phase = CommissioningPhase.RECOVERY_REQUIRED;
      throw error;
    }
  }

  /**
   * Finish verification from a complete browser draft after a page reload.
   * The active configuration and optional saved commit identity are checked
   * again immediately before opening the diagnostic scan transaction.
   */
  async verifyPendingAfterInspect(document) {
    requirePhase(
      this.phase,
      CommissioningPhase.READY,
      "verify a saved probe mapping",
    );
    this.phase = CommissioningPhase.VERIFYING;
    this._clearError();

    let diagnosticTransaction = false;
    try {
      const info = await this.client.info();
      requireCompatibleDevice(info);
      if (info.restartRequired) {
        fail(
          "recovery-restart-required",
          "The logger must restart before the saved configuration can be verified.",
        );
      }
      if (info.commissioning) {
        fail(
          "recovery-transaction-active",
          "The logger has another commissioning transaction open.",
        );
      }

      const configuration = await this.client.getConfiguration();
      if (configuration.restartRequired) {
        fail(
          "recovery-restart-required",
          "The saved configuration must be activated by restart before it can be verified.",
        );
      }
      const match = matchPendingMapping(document, configuration);
      if (!match) {
        fail(
          "pending-mapping-mismatch",
          "The active logger configuration does not exactly match the saved pending mapping.",
        );
      }
      requireActiveGeneration(info, match.generation);

      await this.client.begin(GEOMETRY_ID);
      diagnosticTransaction = true;
      this.transactionOpen = true;
      const scan = await this.client.scan();
      const verified = verifyPostRebootState(
        info,
        configuration,
        scan,
        configuration,
        match.roms,
      );
      const abortResult = await this.client.abort();
      requireClearedAbort(abortResult);
      diagnosticTransaction = false;
      this.transactionOpen = false;

      this.deviceInfo = copyData(info);
      this.existingConfiguration = copyData(configuration);
      this.mappedRoms = [...match.roms];
      this.committedConfiguration = copyData(configuration);
      this.commitMayHaveReachedDevice = false;
      this.phase = CommissioningPhase.COMPLETE;
      return verified;
    } catch (error) {
      if (diagnosticTransaction) {
        try {
          const abortResult = await this.client.abort();
          requireClearedAbort(abortResult);
          this.transactionOpen = false;
        } catch (abortError) {
          this._rememberError(abortError);
          this.phase = CommissioningPhase.RECOVERY_REQUIRED;
          throw new CommissioningWorkflowError(
            "verification-abort-failed",
            "Saved-map verification failed and its diagnostic transaction could not be cleared.",
            { cause: abortError, recoverable: false },
          );
        }
      }
      this._rememberError(error);
      this.phase = CommissioningPhase.READY;
      throw error;
    }
  }

  exportDraft() {
    return buildMappingDocument(this.mappedRoms);
  }

  exportVerifiedMapping() {
    requirePhase(
      this.phase,
      CommissioningPhase.COMPLETE,
      "export the verified mapping",
    );
    return buildMappingDocument(this.mappedRoms, this.committedConfiguration);
  }
}
