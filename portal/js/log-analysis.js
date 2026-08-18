// Dependency-free parser and analysis primitives for sauna logger .slog files.
//
// Raw files remain the source of truth. parseSlog() takes its own exact byte
// copy before interpreting anything, rejects an untrusted header, and only
// exposes records from complete CRC-valid blocks. A damaged tail can therefore
// never invalidate earlier committed blocks or manufacture partial samples.

export const SLOG_LIMITS = Object.freeze({
  maximumBytes: 128 * 1024,
  sensorCount: 8,
  recordsPerBlock: 60,
  maximumRecordsPerSegment: 4382,
  maximumRunSegments: 512,
  maximumRunPoints: 262144,
});

const HEADER_MAGIC = Object.freeze([
  0x53, 0x41, 0x55, 0x4e, 0x4c, 0x4f, 0x47, 0x31,
]); // SAUNLOG1
const HEADER_V1_BYTES = 46;
const HEADER_V2_BYTES = 58;
const DESCRIPTOR_BYTES = 10;
const CRC_BYTES = 4;
const BLOCK_BYTES = 16;
const RECORD_V1_BYTES = 21;
const RECORD_V2_BYTES = 25;
const FOOTER_BYTES = 20;
const BLOCK_MAGIC = 0x314b4c42; // BLK1
const FOOTER_MAGIC = 0x31444e45; // END1
const THRESHOLDS_C = Object.freeze([40, 60, 80, 100]);

const FINISH_REASONS = Object.freeze({
  1: "normal_cooling",
  2: "max_duration",
  3: "storage_full",
});

const RESET_REASONS = Object.freeze({
  1: "power_on",
  2: "external",
  3: "software",
  4: "panic",
  5: "interrupt_watchdog",
  6: "task_watchdog",
  7: "other_watchdog",
  8: "deep_sleep",
  9: "brownout",
  10: "sdio",
});

const CONTINUATION_KINDS = Object.freeze({
  0: "none",
  1: "max_duration",
  2: "probable_power_restore",
  3: "max_duration_sample_anchored",
});

const RTC_SOURCES = Object.freeze({
  0: "internal_rc",
  1: "external_32k_xtal",
  2: "internal_8m_div256",
});

export class SlogParseError extends Error {
  constructor(code, message, { offset = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SlogParseError";
    this.code = code;
    this.offset = offset;
  }
}

export class SlogAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SlogAnalysisError";
    this.code = code;
  }
}

function parseFailure(code, message, offset = null) {
  throw new SlogParseError(code, message, { offset });
}

function analysisFailure(code, message) {
  throw new SlogAnalysisError(code, message);
}

function exactBytes(input) {
  let view;
  if (input instanceof ArrayBuffer) {
    view = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    parseFailure(
      "invalid-input",
      "a sauna log must be provided as an ArrayBuffer or typed-array view",
    );
  }
  return Uint8Array.from(view);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

/** Return the same incremental CRC-32 used by firmware and Python zlib. */
export function slogCrc32(input, initial = 0) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : null;
  if (!bytes) throw new TypeError("CRC input must be binary data");
  if (!Number.isInteger(initial) || initial < 0 || initial > 0xffffffff) {
    throw new TypeError("initial CRC must be an unsigned 32-bit integer");
  }
  let crc = (~initial) >>> 0;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
}

function bytesEqualAt(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result.toUpperCase();
}

function namedValue(values, value, prefix) {
  return values[value] ?? `${prefix}_${value}`;
}

function frozenSample(relativeSeconds, temperaturesC, chipTemperatureC, statusFlags) {
  return Object.freeze({
    relativeSeconds,
    temperaturesC: Object.freeze(temperaturesC),
    chipTemperatureC,
    statusFlags,
  });
}

/**
 * Parse one raw .slog segment.
 *
 * The returned rawBytes is an exact defensive copy of the input and should be
 * offered for download before any destructive device operation. Semantic
 * metadata and samples are derived views; they never replace those bytes.
 */
export function parseSlog(input, { maxBytes = SLOG_LIMITS.maximumBytes } = {}) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > SLOG_LIMITS.maximumBytes
  ) {
    throw new TypeError(
      `maxBytes must be between 1 and ${SLOG_LIMITS.maximumBytes}`,
    );
  }

  const rawBytes = exactBytes(input);
  if (rawBytes.byteLength > maxBytes) {
    parseFailure(
      "file-too-large",
      `sauna log is ${rawBytes.byteLength} bytes; limit is ${maxBytes}`,
    );
  }
  if (rawBytes.byteLength < 12) {
    parseFailure("truncated-header", "file is shorter than a session header", 0);
  }

  const view = new DataView(
    rawBytes.buffer,
    rawBytes.byteOffset,
    rawBytes.byteLength,
  );
  const version = view.getUint16(8, true);
  const fixedHeaderBytes =
    version === 1 ? HEADER_V1_BYTES : version === 2 ? HEADER_V2_BYTES : null;
  if (fixedHeaderBytes === null) {
    parseFailure("unsupported-version", `unsupported session version ${version}`, 8);
  }
  const minimumHeaderBytes =
    fixedHeaderBytes + SLOG_LIMITS.sensorCount * DESCRIPTOR_BYTES + CRC_BYTES;
  if (rawBytes.byteLength < minimumHeaderBytes) {
    parseFailure("truncated-header", "file is shorter than a session header", 0);
  }
  if (!bytesEqualAt(rawBytes, HEADER_MAGIC)) {
    parseFailure(
      "invalid-magic",
      "unsupported session magic or version",
      0,
    );
  }

  const headerSize = view.getUint16(10, true);
  const sensorCount = view.getUint8(26);
  const requiredHeaderSize =
    fixedHeaderBytes + sensorCount * DESCRIPTOR_BYTES + CRC_BYTES;
  if (headerSize > rawBytes.byteLength || headerSize < requiredHeaderSize) {
    parseFailure("invalid-header-size", "invalid header size", 10);
  }
  const storedHeaderCrc = view.getUint32(headerSize - CRC_BYTES, true);
  const actualHeaderCrc = slogCrc32(rawBytes.subarray(0, headerSize - CRC_BYTES));
  if (actualHeaderCrc !== storedHeaderCrc) {
    parseFailure("header-crc-mismatch", "header CRC mismatch", headerSize - 4);
  }
  if (sensorCount !== SLOG_LIMITS.sensorCount) {
    parseFailure(
      "invalid-sensor-count",
      `expected ${SLOG_LIMITS.sensorCount} sensors, found ${sensorCount}`,
      26,
    );
  }

  const sensors = [];
  let descriptorOffset = fixedHeaderBytes;
  for (let index = 0; index < sensorCount; index += 1) {
    sensors.push(
      Object.freeze({
        position: index + 1,
        rom: hex(rawBytes.subarray(descriptorOffset, descriptorOffset + 8)),
        relativeHeightCm: view.getInt16(descriptorOffset + 8, true),
      }),
    );
    descriptorOffset += DESCRIPTOR_BYTES;
  }

  const samples = [];
  const warnings = [];
  const recordBytes = version === 1 ? RECORD_V1_BYTES : RECORD_V2_BYTES;
  let finalized = false;
  let finishReason = "interrupted";
  let finalRelativeSeconds = null;
  let footerRecordCount = null;
  let expectedSequence = 0;
  let validBlockCount = 0;
  let previousRelativeSeconds = null;
  let warnedNonMonotonicTime = false;
  let offset = headerSize;
  let consumedBytes = headerSize;

  while (offset < rawBytes.byteLength) {
    const remaining = rawBytes.byteLength - offset;
    if (
      remaining >= FOOTER_BYTES &&
      view.getUint32(offset, true) === FOOTER_MAGIC
    ) {
      const footerCrc = view.getUint32(offset + 16, true);
      const actualFooterCrc = slogCrc32(
        rawBytes.subarray(offset, offset + FOOTER_BYTES - CRC_BYTES),
      );
      consumedBytes = offset + FOOTER_BYTES;
      if (actualFooterCrc !== footerCrc) {
        warnings.push("invalid footer CRC; treating session as interrupted");
      } else {
        finalized = true;
        const reason = view.getUint8(offset + 4);
        finishReason = namedValue(FINISH_REASONS, reason, "reason");
        footerRecordCount = view.getUint32(offset + 8, true);
        finalRelativeSeconds = view.getInt32(offset + 12, true);
        if (footerRecordCount !== samples.length) {
          warnings.push(
            `footer says ${footerRecordCount} records; decoded ${samples.length}`,
          );
        }
      }
      const bytesAfterFooter = rawBytes.byteLength - consumedBytes;
      if (bytesAfterFooter > 0) {
        warnings.push(
          `ignored ${bytesAfterFooter} byte${bytesAfterFooter === 1 ? "" : "s"} after session footer`,
        );
      }
      break;
    }

    if (remaining < BLOCK_BYTES) {
      warnings.push("ignored torn trailing block header");
      break;
    }

    const magic = view.getUint32(offset, true);
    const sequence = view.getUint32(offset + 4, true);
    const count = view.getUint16(offset + 8, true);
    const payloadBytes = view.getUint16(offset + 10, true);
    const payloadCrc = view.getUint32(offset + 12, true);
    if (
      magic !== BLOCK_MAGIC ||
      count > SLOG_LIMITS.recordsPerBlock ||
      payloadBytes !== count * recordBytes ||
      samples.length + count > SLOG_LIMITS.maximumRecordsPerSegment
    ) {
      warnings.push("ignored invalid trailing block header");
      break;
    }

    const payloadStart = offset + BLOCK_BYTES;
    const payloadEnd = payloadStart + payloadBytes;
    if (payloadEnd > rawBytes.byteLength) {
      warnings.push("ignored torn trailing block payload");
      break;
    }
    const payload = rawBytes.subarray(payloadStart, payloadEnd);
    if (slogCrc32(payload) !== payloadCrc) {
      warnings.push("ignored trailing block with CRC mismatch");
      break;
    }
    if (sequence !== expectedSequence) {
      warnings.push(
        `block sequence jumped from ${expectedSequence} to ${sequence}`,
      );
    }
    expectedSequence = sequence + 1;

    for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
      const recordOffset = payloadStart + recordIndex * recordBytes;
      const relativeSeconds = view.getInt32(recordOffset, true);
      if (
        previousRelativeSeconds !== null &&
        relativeSeconds <= previousRelativeSeconds &&
        !warnedNonMonotonicTime
      ) {
        warnings.push(
          `sample relative timestamps are not strictly increasing at record ${samples.length}`,
        );
        warnedNonMonotonicTime = true;
      }
      previousRelativeSeconds = relativeSeconds;
      const validMask = view.getUint8(recordOffset + 20);
      const temperaturesC = [];
      for (let sensor = 0; sensor < SLOG_LIMITS.sensorCount; sensor += 1) {
        const centiC = view.getInt16(recordOffset + 4 + sensor * 2, true);
        temperaturesC.push(validMask & (1 << sensor) ? centiC / 100 : null);
      }
      const statusFlags =
        version === 2 ? view.getUint16(recordOffset + 23, true) : 0;
      const chipTemperatureC =
        version === 2 && statusFlags & 1
          ? view.getInt16(recordOffset + 21, true) / 100
          : null;
      samples.push(
        frozenSample(
          relativeSeconds,
          temperaturesC,
          chipTemperatureC,
          statusFlags,
        ),
      );
    }
    validBlockCount += 1;
    offset = payloadEnd;
    consumedBytes = offset;
  }

  const sessionId = view.getUint32(12, true);
  const continuationOf = view.getUint32(42, true);
  const result = {
    version,
    headerSize,
    sessionId,
    sampleIntervalMs: view.getUint32(16, true),
    pretriggerMs: view.getUint32(20, true),
    spacingCm: view.getInt16(24, true),
    startTemperatureC: view.getInt16(28, true) / 100,
    endTemperatureC: view.getInt16(30, true) / 100,
    peakDropC: view.getInt16(32, true) / 100,
    startHoldSeconds: view.getUint32(34, true),
    endHoldSeconds: view.getUint32(38, true),
    continuationOf,
    bootId: version === 2 ? view.getUint32(46, true) : 0,
    resetReason:
      version === 2
        ? namedValue(RESET_REASONS, view.getUint8(50), "reason")
        : "unknown",
    continuationKind:
      version === 2
        ? namedValue(CONTINUATION_KINDS, view.getUint8(51), "kind")
        : continuationOf
          ? "legacy_unspecified"
          : "none",
    continuationDelaySeconds: version === 2 ? view.getUint8(53) : 0,
    initialRtcSource:
      version === 2
        ? namedValue(RTC_SOURCES, view.getUint8(52), "source")
        : "unknown",
    initialRtcHz: version === 2 ? view.getUint32(54, true) : 0,
    sensors: Object.freeze(sensors),
    samples: Object.freeze(samples),
    finalized,
    finishReason,
    finalRelativeSeconds,
    footerRecordCount,
    warnings: Object.freeze(warnings),
    integrity: Object.freeze({
      headerCrc32: storedHeaderCrc,
      validBlockCount,
      committedRecordCount: samples.length,
      consumedBytes,
      ignoredTrailingBytes: rawBytes.byteLength - consumedBytes,
    }),
  };
  // Typed-array elements remain mutable even when their containing object is
  // frozen. Keep the parser's source copy private and issue a fresh copy for
  // every read so callers cannot silently rewrite the alleged raw source.
  Object.defineProperty(result, "rawBytes", {
    enumerable: true,
    get: () => rawBytes.slice(),
  });
  return Object.freeze(result);
}

function requireSession(session, index) {
  if (!session || !Number.isInteger(session.sessionId) || session.sessionId < 1) {
    analysisFailure(
      "invalid-session",
      `run segment ${index + 1} is not a parsed sauna session`,
    );
  }
  if (!Array.isArray(session.sensors) || session.sensors.length !== 8) {
    analysisFailure(
      "invalid-layout",
      `session ${session.sessionId} does not contain eight probe descriptors`,
    );
  }
  if (!Array.isArray(session.samples)) {
    analysisFailure(
      "invalid-session",
      `session ${session.sessionId} has no sample collection`,
    );
  }
  if (!Number.isFinite(session.sampleIntervalMs) || session.sampleIntervalMs <= 0) {
    analysisFailure(
      "invalid-sample-interval",
      `session ${session.sessionId} has an invalid sample interval`,
    );
  }
}

function sameLayout(reference, candidate) {
  return reference.every(
    (sensor, index) =>
      sensor.rom === candidate[index]?.rom &&
      sensor.relativeHeightCm === candidate[index]?.relativeHeightCm,
  );
}

/**
 * Build one logical run from root-to-leaf session segments.
 *
 * observedSeconds deliberately removes unknown power-off time. A v2
 * max-duration continuation is aligned only from its recorded sample-to-trigger
 * delay and its overlapping pre-trigger records are omitted from the derived timeline. All
 * other continuation boundaries remain present in breaks with
 * durationSeconds:null; callers must render them and must not treat adjacent
 * observed timestamps as a measurement of power-off duration.
 */
export function buildRun(inputSessions) {
  if (!Array.isArray(inputSessions) || inputSessions.length === 0) {
    analysisFailure("empty-run", "a run needs at least one session");
  }
  if (inputSessions.length > SLOG_LIMITS.maximumRunSegments) {
    analysisFailure(
      "run-too-large",
      `a run can contain at most ${SLOG_LIMITS.maximumRunSegments} segments`,
    );
  }

  const sessions = inputSessions.slice();
  sessions.forEach(requireSession);
  const ids = new Set();
  const reference = sessions[0].sensors;
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (ids.has(session.sessionId)) {
      analysisFailure(
        "duplicate-session",
        `session ${session.sessionId} appears more than once in the run`,
      );
    }
    ids.add(session.sessionId);
    if (!sameLayout(reference, session.sensors)) {
      analysisFailure(
        "layout-mismatch",
        `session ${session.sessionId} has a different sensor layout`,
      );
    }
    if (
      index > 0 &&
      session.continuationOf !== sessions[index - 1].sessionId
    ) {
      analysisFailure(
        "broken-continuation",
        `session ${session.sessionId} does not continue session ${sessions[index - 1].sessionId}`,
      );
    }
  }

  const points = [];
  const breaks = [];
  const warnings = [];
  if (sessions[0].continuationOf !== 0) {
    warnings.push(
      `session ${sessions[0].sessionId}: predecessor ${sessions[0].continuationOf} was not supplied; the segment is shown on its own relative timeline`,
    );
  }
  const segmentTimeRanges = [];
  let previousEnd = null;
  let previousSegmentHadPoints = false;
  for (let segment = 0; segment < sessions.length; segment += 1) {
    const session = sessions[segment];
    warnings.push(
      ...session.warnings.map(
        (warning) => `session ${session.sessionId}: ${warning}`,
      ),
    );
    if (session.samples.length === 0) {
      warnings.push(`session ${session.sessionId}: no committed samples`);
      segmentTimeRanges.push(
        Object.freeze({
          sessionId: session.sessionId,
          firstRelativeSeconds: null,
          lastRelativeSeconds: null,
        }),
      );
      previousSegmentHadPoints = false;
      continue;
    }
    if (points.length + session.samples.length > SLOG_LIMITS.maximumRunPoints) {
      analysisFailure(
        "run-too-large",
        `a run can contain at most ${SLOG_LIMITS.maximumRunPoints} samples`,
      );
    }
    const firstRelativeSeconds = session.samples[0].relativeSeconds;
    const lastRelativeSeconds = session.samples.at(-1).relativeSeconds;
    const intervalSeconds = session.sampleIntervalMs / 1000;
    const predecessor = segment > 0 ? sessions[segment - 1] : null;
    const isProvenMaxDurationContinuation =
      previousEnd !== null &&
      previousSegmentHadPoints &&
      session.version === 2 &&
      session.continuationKind === "max_duration_sample_anchored" &&
      Number.isInteger(session.continuationDelaySeconds) &&
      session.continuationDelaySeconds > 0 &&
      session.continuationDelaySeconds >= session.startHoldSeconds &&
      session.continuationDelaySeconds <= 0xff &&
      predecessor?.version === 2 &&
      predecessor.finalized === true &&
      predecessor.finishReason === "max_duration" &&
      predecessor.footerRecordCount === predecessor.samples.length &&
      predecessor.finalRelativeSeconds ===
        predecessor.samples.at(-1)?.relativeSeconds &&
      predecessor.bootId !== 0 &&
      predecessor.bootId === session.bootId &&
      predecessor.sampleIntervalMs === session.sampleIntervalMs;
    let offset = 0;
    if (isProvenMaxDurationContinuation) {
      // The child timestamp zero is its trigger. Firmware recorded the whole-
      // second delay from the predecessor's final captured sample; its RAM
      // pre-trigger ring therefore repeats part of the predecessor. Keep the
      // raw child intact on session.rawBytes, but omit repeated points here.
      offset = previousEnd + session.continuationDelaySeconds;
    } else if (previousEnd !== null) {
      // The preceding segment and this first child sample are separated by an
      // unknown amount of powered-off time. Put both endpoints at the same
      // compressed observed-time coordinate and let the explicit break carry
      // the discontinuity; even one nominal sample interval would invent time.
      offset = previousEnd - firstRelativeSeconds;
      breaks.push(
        Object.freeze({
          observedSeconds: previousEnd,
          afterSegment: segment - 1,
          beforeSegment: segment,
          continuationKind: session.continuationKind,
          durationSeconds: null,
        }),
      );
      if (session.version === 1) {
        warnings.push(
          `session ${session.sessionId}: legacy continuation timing cannot prove whether pre-trigger records overlap; kept as a separate segment`,
        );
      } else if (session.continuationKind !== "probable_power_restore") {
        warnings.push(
          `session ${session.sessionId}: continuation kind ${session.continuationKind} does not prove continuous timing; treated as an unknown gap`,
        );
      }
    } else if (segment > 0) {
      breaks.push(
        Object.freeze({
          observedSeconds: null,
          afterSegment: segment - 1,
          beforeSegment: segment,
          continuationKind: session.continuationKind,
          durationSeconds: null,
        }),
      );
      warnings.push(
        `session ${session.sessionId}: continuation timing cannot be placed because the preceding segment has no committed endpoint`,
      );
    }
    let omittedOverlap = 0;
    let appendedPoints = 0;
    for (const sample of session.samples) {
      const observedSeconds = sample.relativeSeconds + offset;
      if (
        isProvenMaxDurationContinuation &&
        observedSeconds <= previousEnd
      ) {
        omittedOverlap += 1;
        continue;
      }
      points.push(
        Object.freeze({
          observedSeconds,
          segment,
          sessionId: session.sessionId,
          relativeSeconds: sample.relativeSeconds,
          temperaturesC: sample.temperaturesC,
          chipTemperatureC: sample.chipTemperatureC,
          statusFlags: sample.statusFlags,
        }),
      );
      appendedPoints += 1;
    }
    if (omittedOverlap > 0) {
      warnings.push(
        `session ${session.sessionId}: omitted ${omittedOverlap} overlapping max-duration pre-trigger record${omittedOverlap === 1 ? "" : "s"} from derived time`,
      );
    }
    if (points.length > 0) previousEnd = points.at(-1).observedSeconds;
    previousSegmentHadPoints = appendedPoints > 0;
    segmentTimeRanges.push(
      Object.freeze({
        sessionId: session.sessionId,
        firstRelativeSeconds,
        lastRelativeSeconds,
      }),
    );
  }

  return Object.freeze({
    sessions: Object.freeze(sessions),
    sensors: reference,
    points: Object.freeze(points),
    breaks: Object.freeze(breaks),
    warnings: Object.freeze(warnings),
    segmentTimeRanges: Object.freeze(segmentTimeRanges),
  });
}

function issueSeverity(status) {
  return status === "ambiguous" ? 2 : status === "incomplete" ? 1 : 0;
}

/**
 * Conservatively group an unordered session catalog into unambiguous chains.
 *
 * `runs` contains only root-to-leaf arrays that are safe to pass to buildRun.
 * `groups` also retains incomplete and ambiguous components so the UI can
 * explain missing parents, duplicate IDs, branches, cycles, or layout changes
 * instead of guessing. A layout-mismatched child is never attached to the
 * referenced parent; the valid parent can remain an independently usable run.
 */
export function groupSessionsIntoRuns(inputSessions) {
  if (!Array.isArray(inputSessions)) {
    analysisFailure("invalid-catalog", "session catalog must be an array");
  }
  if (inputSessions.length > SLOG_LIMITS.maximumRunSegments) {
    analysisFailure(
      "catalog-too-large",
      `a catalog can contain at most ${SLOG_LIMITS.maximumRunSegments} sessions`,
    );
  }
  if (inputSessions.length === 0) {
    return Object.freeze({ groups: Object.freeze([]), runs: Object.freeze([]) });
  }

  const sessions = inputSessions.slice();
  sessions.forEach(requireSession);
  const indicesById = new Map();
  for (let index = 0; index < sessions.length; index += 1) {
    const id = sessions[index].sessionId;
    if (!indicesById.has(id)) indicesById.set(id, []);
    indicesById.get(id).push(index);
  }

  const adjacency = sessions.map(() => new Set());
  const issueLists = sessions.map(() => []);
  const parentOf = Array(sessions.length).fill(null);
  const childrenOf = sessions.map(() => []);
  let issueSequence = 0;

  function connect(left, right) {
    if (left === right) return;
    adjacency[left].add(right);
    adjacency[right].add(left);
  }

  function recordIssue(status, code, message, affected, relatedIds = []) {
    const issue = {
      key: issueSequence,
      status,
      code,
      message,
      relatedSessionIds: [...new Set(relatedIds)].sort((a, b) => a - b),
    };
    issueSequence += 1;
    for (const index of new Set(affected)) issueLists[index].push(issue);
  }

  for (const [id, indices] of indicesById) {
    if (indices.length < 2) continue;
    for (let index = 1; index < indices.length; index += 1) {
      connect(indices[0], indices[index]);
    }
    recordIssue(
      "ambiguous",
      "duplicate-session-id",
      `session ID ${id} occurs ${indices.length} times`,
      indices,
      [id],
    );
  }

  for (let childIndex = 0; childIndex < sessions.length; childIndex += 1) {
    const child = sessions[childIndex];
    if (!child.continuationOf) continue;
    const candidates = indicesById.get(child.continuationOf) ?? [];
    if (candidates.length === 0) {
      recordIssue(
        "incomplete",
        "missing-parent",
        `session ${child.sessionId} refers to missing session ${child.continuationOf}`,
        [childIndex],
        [child.sessionId, child.continuationOf],
      );
      continue;
    }
    if (candidates.length > 1) {
      for (const parentIndex of candidates) connect(childIndex, parentIndex);
      recordIssue(
        "ambiguous",
        "ambiguous-parent",
        `session ${child.sessionId} refers to duplicated session ID ${child.continuationOf}`,
        [childIndex, ...candidates],
        [child.sessionId, child.continuationOf],
      );
      continue;
    }

    const parentIndex = candidates[0];
    const parent = sessions[parentIndex];
    if (!sameLayout(parent.sensors, child.sensors)) {
      recordIssue(
        "incomplete",
        "layout-mismatch",
        `session ${child.sessionId} cannot continue session ${parent.sessionId} because the ordered probe layout changed`,
        [childIndex],
        [child.sessionId, parent.sessionId],
      );
      continue;
    }

    connect(childIndex, parentIndex);
    parentOf[childIndex] = parentIndex;
    childrenOf[parentIndex].push(childIndex);
    if (parent.sessionId >= child.sessionId) {
      recordIssue(
        "ambiguous",
        "non-monotonic-link",
        `session ${child.sessionId} does not follow a lower parent session ID`,
        [childIndex, parentIndex],
        [child.sessionId, parent.sessionId],
      );
    }
  }

  for (let parentIndex = 0; parentIndex < childrenOf.length; parentIndex += 1) {
    const children = childrenOf[parentIndex];
    if (children.length < 2) continue;
    recordIssue(
      "ambiguous",
      "continuation-branch",
      `session ${sessions[parentIndex].sessionId} has ${children.length} continuation children`,
      [parentIndex, ...children],
      [
        sessions[parentIndex].sessionId,
        ...children.map((index) => sessions[index].sessionId),
      ],
    );
  }

  // Each child has at most one accepted parent, so following parentOf is a
  // bounded functional-graph cycle check.
  const visitState = Array(sessions.length).fill(0);
  for (let start = 0; start < sessions.length; start += 1) {
    if (visitState[start] !== 0) continue;
    const path = [];
    const position = new Map();
    let cursor = start;
    while (cursor !== null && visitState[cursor] === 0) {
      visitState[cursor] = 1;
      position.set(cursor, path.length);
      path.push(cursor);
      cursor = parentOf[cursor];
    }
    if (cursor !== null && position.has(cursor)) {
      const cycle = path.slice(position.get(cursor));
      recordIssue(
        "ambiguous",
        "continuation-cycle",
        `continuation cycle contains session IDs ${cycle
          .map((index) => sessions[index].sessionId)
          .join(", ")}`,
        cycle,
        cycle.map((index) => sessions[index].sessionId),
      );
    }
    for (const index of path) visitState[index] = 2;
  }

  const seen = new Set();
  const groups = [];
  for (let start = 0; start < sessions.length; start += 1) {
    if (seen.has(start)) continue;
    const component = [];
    const pending = [start];
    seen.add(start);
    while (pending.length > 0) {
      const index = pending.pop();
      component.push(index);
      for (const neighbor of adjacency[index]) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        pending.push(neighbor);
      }
    }

    const issuesByKey = new Map();
    for (const index of component) {
      for (const issue of issueLists[index]) issuesByKey.set(issue.key, issue);
    }
    const issues = [...issuesByKey.values()];
    const status = issues.reduce(
      (current, issue) =>
        issueSeverity(issue.status) > issueSeverity(current)
          ? issue.status
          : current,
      "ready",
    );

    let orderedIndices;
    if (status === "ready") {
      const root = component.find((index) => parentOf[index] === null);
      orderedIndices = [];
      let cursor = root;
      while (cursor !== undefined && cursor !== null) {
        orderedIndices.push(cursor);
        cursor = childrenOf[cursor][0];
      }
      if (orderedIndices.length !== component.length) {
        analysisFailure(
          "internal-chain-error",
          "validated continuation component could not be ordered",
        );
      }
    } else {
      orderedIndices = component.slice().sort((left, right) => {
        const difference = sessions[left].sessionId - sessions[right].sessionId;
        return difference || left - right;
      });
    }

    const groupSessions = Object.freeze(
      orderedIndices.map((index) => sessions[index]),
    );
    groups.push(
      Object.freeze({
        status,
        rootSessionId:
          status === "ready" ? groupSessions[0]?.sessionId ?? null : null,
        sessions: groupSessions,
        sessionIds: Object.freeze(
          groupSessions.map((session) => session.sessionId),
        ),
        issues: Object.freeze(
          issues.map((issue) =>
            Object.freeze({
              status: issue.status,
              code: issue.code,
              message: issue.message,
              relatedSessionIds: Object.freeze(issue.relatedSessionIds),
            }),
          ),
        ),
      }),
    );
  }

  groups.sort((left, right) => {
    const leftId = left.sessionIds[0] ?? Number.MAX_SAFE_INTEGER;
    const rightId = right.sessionIds[0] ?? Number.MAX_SAFE_INTEGER;
    return leftId - rightId;
  });
  return Object.freeze({
    groups: Object.freeze(groups),
    runs: Object.freeze(
      groups
        .filter((group) => group.status === "ready")
        .map((group) => group.sessions),
    ),
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function linearRegression(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const xMean = mean(xs);
  const yMean = mean(ys);
  let denominator = 0;
  let numerator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    denominator += (xs[index] - xMean) ** 2;
    numerator += (xs[index] - xMean) * (ys[index] - yMean);
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  let total = 0;
  let residual = 0;
  for (let index = 0; index < ys.length; index += 1) {
    const predicted = yMean + slope * (xs[index] - xMean);
    total += (ys[index] - yMean) ** 2;
    residual += (ys[index] - predicted) ** 2;
  }
  return Object.freeze({
    slope,
    rSquared: total === 0 ? 1 : Math.max(0, 1 - residual / total),
  });
}

function verticalMetrics(run) {
  const heightsM = run.sensors.map(
    (sensor) => sensor.relativeHeightCm / 100,
  );
  const gradients = [];
  const spreads = [];
  for (const point of run.points) {
    const xs = [];
    const ys = [];
    for (let probe = 0; probe < run.sensors.length; probe += 1) {
      const temperature = point.temperaturesC[probe];
      if (temperature !== null) {
        xs.push(heightsM[probe]);
        ys.push(temperature);
      }
    }
    const fit = xs.length >= 4 ? linearRegression(xs, ys) : null;
    gradients.push(fit?.slope ?? null);
    const top = point.temperaturesC[0];
    const bottom = point.temperaturesC.at(-1);
    spreads.push(top !== null && bottom !== null ? top - bottom : null);
  }
  return { gradients, spreads };
}

function windowSlopes(run, probe) {
  const slopes = Array(run.points.length).fill(null);
  const segments = new Map();
  for (let index = 0; index < run.points.length; index += 1) {
    const segment = run.points[index].segment;
    if (!segments.has(segment)) segments.set(segment, []);
    segments.get(segment).push(index);
  }
  for (const indices of segments.values()) {
    let left = 0;
    let right = 0;
    for (let position = 0; position < indices.length; position += 1) {
      const centerIndex = indices[position];
      const centerTime = run.points[centerIndex].observedSeconds;
      while (
        left < indices.length &&
        run.points[indices[left]].observedSeconds < centerTime - 60
      ) {
        left += 1;
      }
      right = Math.max(right, position);
      while (
        right + 1 < indices.length &&
        run.points[indices[right + 1]].observedSeconds <= centerTime + 60
      ) {
        right += 1;
      }
      const xs = [];
      const ys = [];
      for (let cursor = left; cursor <= right; cursor += 1) {
        const point = run.points[indices[cursor]];
        const temperature = point.temperaturesC[probe];
        if (temperature !== null) {
          xs.push(point.observedSeconds / 60);
          ys.push(temperature);
        }
      }
      const fit = xs.length >= 9 ? linearRegression(xs, ys) : null;
      slopes[centerIndex] = fit?.slope ?? null;
    }
  }
  return slopes;
}

function durationAbove(run, probe, threshold) {
  let seconds = 0;
  const unknownBoundaries = new Set(
    run.breaks.map((gap) => `${gap.afterSegment}:${gap.beforeSegment}`),
  );
  for (let index = 0; index + 1 < run.points.length; index += 1) {
    const first = run.points[index];
    const second = run.points[index + 1];
    const elapsed = second.observedSeconds - first.observedSeconds;
    if (
      unknownBoundaries.has(`${first.segment}:${second.segment}`) ||
      elapsed <= 0 ||
      elapsed > 20
    ) {
      continue;
    }
    const a = first.temperaturesC[probe];
    const b = second.temperaturesC[probe];
    if (a === null || b === null) continue;
    if (a >= threshold && b >= threshold) {
      seconds += elapsed;
    } else if ((a >= threshold) !== (b >= threshold) && a !== b) {
      const fraction = Math.abs((threshold - a) / (b - a));
      seconds += elapsed * (a < threshold ? 1 - fraction : fraction);
    }
  }
  return Number((seconds / 60).toFixed(2));
}

function extrema(values) {
  if (values.length === 0) {
    return Object.freeze({ minimum: null, maximum: null, mean: null });
  }
  let minimum = values[0];
  let maximum = values[0];
  let sum = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sum += value;
  }
  return Object.freeze({ minimum, maximum, mean: sum / values.length });
}

/** Produce a JSON-safe, conservative summary of one logical run. */
export function analyzeRun(run) {
  if (!run || !Array.isArray(run.points) || !Array.isArray(run.sensors)) {
    analysisFailure("invalid-run", "analysis requires a run from buildRun()");
  }
  const { gradients, spreads } = verticalMetrics(run);
  const validGradients = gradients.filter((value) => value !== null);
  const validSpreads = spreads.filter((value) => value !== null);
  const chipTemperatures = run.points
    .map((point) => point.chipTemperatureC)
    .filter((value) => value !== null);
  const firstPoint = run.points[0] ?? null;
  const lastPoint = run.points.at(-1) ?? null;

  let startState = "no_committed_samples";
  if (firstPoint) {
    startState = firstPoint.temperaturesC.some(
      (temperature) => temperature !== null && temperature >= 40,
    )
      ? "already_hot_or_warming"
      : "below_trigger_at_first_sample";
  }

  const rootSession = run.sessions[0];
  const expectedFirstRelativeSeconds = -Math.max(
    0,
    (rootSession.pretriggerMs - rootSession.sampleIntervalMs) / 1000,
  );
  const pretriggerCoverage = firstPoint
    ? firstPoint.relativeSeconds <= expectedFirstRelativeSeconds
      ? "full"
      : "partial"
    : "no_committed_samples";

  const probes = run.sensors.map((sensor, probe) => {
    const values = [];
    for (const point of run.points) {
      const temperature = point.temperaturesC[probe];
      if (temperature !== null) {
        values.push([point.observedSeconds, temperature]);
      }
    }
    const slopes = windowSlopes(run, probe).filter((value) => value !== null);
    const crossings = {};
    const minutesAbove = {};
    for (const threshold of THRESHOLDS_C) {
      crossings[String(threshold)] =
        values.find(([, temperature]) => temperature >= threshold)?.[0] ?? null;
      minutesAbove[String(threshold)] = durationAbove(run, probe, threshold);
    }
    const temperatures = values.map(([, temperature]) => temperature);
    const temperatureStats = extrema(temperatures);
    const slopeStats = extrema(slopes);
    const peak = values.length
      ? values.reduce((best, candidate) =>
          candidate[1] > best[1] ? candidate : best,
        )
      : null;
    return Object.freeze({
      position: probe + 1,
      rom: sensor.rom,
      relative_height_cm: sensor.relativeHeightCm,
      valid_samples: values.length,
      missing_samples: run.points.length - values.length,
      minimum_c: temperatureStats.minimum,
      maximum_c: temperatureStats.maximum,
      mean_c: temperatures.length ? mean(temperatures) : null,
      peak_observed_seconds: peak?.[0] ?? null,
      maximum_heating_rate_c_per_min: slopeStats.maximum,
      maximum_cooling_rate_c_per_min: slopeStats.minimum,
      threshold_crossing_observed_seconds: Object.freeze(crossings),
      minutes_above: Object.freeze(minutesAbove),
    });
  });

  return Object.freeze({
    label: `Sauna ${run.sessions.length === 1 ? "session" : "sessions"} ${run.sessions
      .map((session) => session.sessionId)
      .join(" → ")}`,
    segments: Object.freeze(run.sessions.map((session) => session.sessionId)),
    observed_duration_seconds:
      firstPoint && lastPoint
        ? lastPoint.observedSeconds - firstPoint.observedSeconds
        : 0,
    unknown_gap_count: run.breaks.length,
    start_state: startState,
    pretrigger_coverage: pretriggerCoverage,
    expected_first_relative_seconds: expectedFirstRelativeSeconds,
    first_relative_seconds: firstPoint?.relativeSeconds ?? null,
    last_relative_seconds: lastPoint?.relativeSeconds ?? null,
    segment_relative_time_ranges: Object.freeze(
      run.segmentTimeRanges.map((range) =>
        Object.freeze({
          session_id: range.sessionId,
          first_relative_seconds: range.firstRelativeSeconds,
          last_relative_seconds: range.lastRelativeSeconds,
        }),
      ),
    ),
    warnings: Object.freeze(run.warnings.slice()),
    chip_temperature_c: extrema(chipTemperatures),
    degraded_sample_count: run.points.reduce(
      (count, point) => count + (point.statusFlags & 8 ? 1 : 0),
      0,
    ),
    rtc_xtal_fallback_observed: run.points.some(
      (point) => Boolean(point.statusFlags & 4),
    ),
    vertical_gradient_c_per_m: extrema(validGradients),
    top_bottom_spread_c: extrema(validSpreads),
    probes: Object.freeze(probes),
  });
}
