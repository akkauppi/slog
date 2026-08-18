#include "session_logger.h"

#include <LittleFS.h>
#include <Preferences.h>
#include <esp_core_dump.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <soc/rtc.h>

#include <memory>
#include <new>

namespace sauna {
namespace {
constexpr char kHeaderMagic[8] = {'S', 'A', 'U', 'N', 'L', 'O', 'G', '1'};
constexpr uint32_t kBlockMagic = 0x314B4C42;   // BLK1
constexpr uint32_t kFooterMagic = 0x31444E45;  // END1

struct __attribute__((packed)) SensorDescriptor {
  uint8_t rom[8];
  int16_t relativeHeightCm;
};

struct __attribute__((packed)) SessionHeaderV1 {
  char magic[8];
  uint16_t version;
  uint16_t headerSize;
  uint32_t sessionId;
  uint32_t sampleIntervalMs;
  uint32_t pretriggerMs;
  int16_t spacingCm;
  uint8_t sensorCount;
  uint8_t reserved;
  int16_t startCentiC;
  int16_t endCentiC;
  int16_t peakDropCentiC;
  uint32_t startHoldSeconds;
  uint32_t endHoldSeconds;
  uint32_t continuationOf;
  SensorDescriptor sensors[kSensorCount];
  uint32_t headerCrc;
};

struct __attribute__((packed)) SessionHeaderV2 {
  char magic[8];
  uint16_t version;
  uint16_t headerSize;
  uint32_t sessionId;
  uint32_t sampleIntervalMs;
  uint32_t pretriggerMs;
  int16_t spacingCm;
  uint8_t sensorCount;
  uint8_t reserved;
  int16_t startCentiC;
  int16_t endCentiC;
  int16_t peakDropCentiC;
  uint32_t startHoldSeconds;
  uint32_t endHoldSeconds;
  uint32_t continuationOf;
  uint32_t bootId;
  uint8_t resetReason;
  uint8_t continuationKind;
  uint8_t initialRtcSource;
  // For MaxDurationSampleAnchored, whole seconds from the predecessor's final
  // captured sample to this segment's trigger. Zero means no proven timing.
  uint8_t continuationDelaySeconds;
  uint32_t initialRtcHz;
  SensorDescriptor sensors[kSensorCount];
  uint32_t headerCrc;
};

struct __attribute__((packed)) StoredRecordV1 {
  int32_t relativeSeconds;
  int16_t centiC[kSensorCount];
  uint8_t validMask;
};

struct __attribute__((packed)) StoredRecordV2 {
  int32_t relativeSeconds;
  int16_t centiC[kSensorCount];
  uint8_t validMask;
  int16_t chipCentiC;
  uint16_t statusFlags;
};

struct __attribute__((packed)) BlockHeader {
  uint32_t magic;
  uint32_t sequence;
  uint16_t recordCount;
  uint16_t payloadBytes;
  uint32_t payloadCrc;
};

struct __attribute__((packed)) SessionFooter {
  uint32_t magic;
  uint8_t reason;
  uint8_t reserved[3];
  uint32_t totalRecords;
  int32_t finalRelativeSeconds;
  uint32_t footerCrc;
};

struct __attribute__((packed)) RetentionAuditV1 {
  uint32_t magic;
  uint32_t deletedRuns;
  uint32_t deletedSegments;
  uint32_t lastDeletedRun;
  uint32_t lastDeletedSegment;
  uint32_t highestSessionId;
  uint32_t crc;
};

struct __attribute__((packed)) RetentionPendingV1 {
  uint32_t magic;
  uint32_t sessionId;
  uint32_t rootId;
  uint32_t crc;
};

static_assert(sizeof(SessionHeaderV1) == 130, "v1 log header layout changed");
static_assert(sizeof(SessionHeaderV2) == 142, "v2 log header layout changed");
static_assert(sizeof(StoredRecordV1) == 21, "v1 record layout changed");
static_assert(sizeof(StoredRecordV2) == 25, "v2 record layout changed");
static_assert(sizeof(SessionFooter) == 20, "log footer layout changed");
static_assert(sizeof(RetentionAuditV1) == 28,
              "retention audit layout changed");
static_assert(sizeof(RetentionPendingV1) == 16,
              "retention pending layout changed");

constexpr uint32_t kRetentionAuditMagic = 0x31545541;    // AUT1
constexpr uint32_t kRetentionPendingMagic = 0x314E4550;  // PEN1
constexpr char kRetentionAuditKey[] = "ret_audit";
constexpr char kRetentionPendingKey[] = "ret_pending";
// Include the first sample at/after the cap plus one scheduler-boundary sample
// when a late conversion is collected immediately before the next starts.
constexpr size_t kMaximumPostTriggerRecords =
    (12UL * 60UL * 60UL * 1000UL) / kSampleIntervalMs + 2;
constexpr size_t kMaximumEncodedRecords =
    kPretriggerRecords + kMaximumPostTriggerRecords;
constexpr size_t kMaximumEncodedBlocks =
    1 + (kMaximumPostTriggerRecords + kRecordsPerBlock - 1) /
            kRecordsPerBlock;
constexpr size_t kMaximumEncodedSessionBytes =
    sizeof(SessionHeaderV2) +
    kMaximumEncodedBlocks * sizeof(BlockHeader) +
    kMaximumEncodedRecords * sizeof(StoredRecordV2) + sizeof(SessionFooter);
constexpr size_t kFilesystemReserveMarginBytes = 4 * 4096;

uint8_t bitCount(uint8_t value) {
  uint8_t count = 0;
  while (value) {
    count += value & 1;
    value >>= 1;
  }
  return count;
}

const char* probeConfigWireState(ProbeConfigState state) {
  switch (state) {
    case ProbeConfigState::Unconfigured:
      return "unconfigured";
    case ProbeConfigState::Ready:
      return "valid";
    case ProbeConfigState::Corrupt:
    case ProbeConfigState::Ambiguous:
    case ProbeConfigState::StorageUnavailable:
      return "invalid";
  }
  return "invalid";
}

bool parseSessionId(const String& path, uint32_t* id) {
  if (!id) return false;
  const int slash = path.lastIndexOf('/');
  const String name = path.substring(slash + 1);
  if (!name.endsWith(".slog") || name.length() <= 5) return false;
  const String number = name.substring(0, name.length() - 5);
  uint32_t parsed = 0;
  for (size_t index = 0; index < number.length(); ++index) {
    const char character = number[index];
    if (character < '0' || character > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(character - '0');
    if (parsed > (UINT32_MAX - digit) / 10U) return false;
    parsed = parsed * 10U + digit;
  }
  if (!parsed) return false;
  char canonical[20];
  snprintf(canonical, sizeof(canonical), "%08u.slog", parsed);
  if (name != canonical) return false;
  *id = parsed;
  return true;
}
}  // namespace

uint32_t crc32(const uint8_t* data, size_t length, uint32_t initial) {
  uint32_t crc = ~initial;
  for (size_t index = 0; index < length; ++index) {
    crc ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (0U - (crc & 1U)));
    }
  }
  return ~crc;
}

bool SessionLogger::setProbeConfiguration(const ProbeMapping* mapping) {
  if (active_) return false;
  probeMappingReady_ =
      mapping && mapping->generation != 0 &&
      validateProbeMapping(*mapping) == ProbeConfigError::None;
  if (probeMappingReady_) {
    probeMapping_ = *mapping;
  } else {
    memset(&probeMapping_, 0, sizeof(probeMapping_));
  }
  resetIdleSamplingState();
  if (filesystemReady_) findInterruptedSession();
  return probeMappingReady_;
}

void SessionLogger::setProbeConfigStatus(ProbeConfigState state,
                                         uint32_t generation,
                                         uint8_t validSlots,
                                         bool restartRequired) {
  probeConfigState_ = state;
  storedProbeConfigGeneration_ = generation;
  probeConfigValidSlots_ = validSlots;
  probeConfigRestartRequired_ = restartRequired;
}

void SessionLogger::setProbeBusStatus(uint8_t discovered,
                                      uint8_t mappedValid) {
  discoveredProbes_ = discovered;
  mappedValidProbes_ = mappedValid;
}

void SessionLogger::setCommissioningMode(bool enabled) {
  if (commissioningMode_ == enabled || (enabled && active_)) return;
  commissioningMode_ = enabled;
  resetIdleSamplingState();
  if (!enabled && filesystemReady_) findInterruptedSession();
}

void SessionLogger::resetIdleSamplingState() {
  if (active_) return;
  ringHead_ = 0;
  ringCount_ = 0;
  pendingCount_ = 0;
  startCandidate_ = false;
  coolingCandidate_ = false;
  aboveStartSinceMs_ = 0;
  coolingSinceMs_ = 0;
  sessionPeakCentiC_ = INT16_MIN;
  continuationOf_ = 0;
  continuationKind_ = ContinuationKind::None;
  continuationAnchorAtMs_ = 0;
  hotContinuationEligible_ = false;
  interruptedSessionWasHot_ = false;
  haveLatestReading_ = false;
}

bool SessionLogger::begin() {
  resetReason_ = static_cast<uint8_t>(esp_reset_reason());
  Preferences preferences;
  if (preferences.begin("sauna", false)) {
    bootId_ = preferences.getUInt("boot_id", 0) + 1;
    preferences.putUInt("boot_id", bootId_);
    preferences.end();
  }
  loadRetentionState();
  return mountFilesystem();
}

bool SessionLogger::mountFilesystem() {
  filesystemReady_ = false;
  for (uint8_t attempt = 0; attempt < 3 && !filesystemReady_; ++attempt) {
    LittleFS.end();
    filesystemReady_ = LittleFS.begin(false);
    if (!filesystemReady_) delay(250);
  }
  if (!filesystemReady_) {
    Serial.println("logger_fs=unavailable action=retry_without_format");
    nextFilesystemRetryAt_ = millis() + kFilesystemRetryMs;
    return false;
  }
  LittleFS.mkdir("/sessions");
  // A non-root pending deletion normally leaves its root on disk. If the
  // directory is empty, power disappeared after explicit LOG FORMAT erased the
  // filesystem but before it reset the retention journal; there is no run to
  // resume. (A pending root may legitimately be the last removed file.)
  if (retentionPendingSegment_ &&
      retentionPendingSegment_ != retentionPendingRun_) {
    File directory = LittleFS.open("/sessions");
    if (directory) {
      File entry = directory.openNextFile();
      const bool empty = !entry;
      if (entry) entry.close();
      directory.close();
      if (empty && !resetRetentionState()) {
        Serial.println("logger_event=retention_audit_unavailable");
      }
    }
  }
  findInterruptedSession();
  if (!retentionAuditAvailable_) {
    Serial.println("logger_event=retention_audit_unavailable");
  } else if (!reconcilePendingRetention()) {
    Serial.println("logger_event=retention_audit_pending");
  } else if (retentionPendingSegment_) {
    Serial.printf("logger_event=retention_resume_pending root=%u segment=%u\n",
                  retentionPendingRun_, retentionPendingSegment_);
  }
  Serial.printf("logger_fs=ready total=%u used=%u\n", LittleFS.totalBytes(),
                LittleFS.usedBytes());
  return true;
}

void SessionLogger::retryFilesystem(uint32_t now) {
  if (filesystemReady_ || static_cast<int32_t>(now - nextFilesystemRetryAt_) < 0)
    return;
  mountFilesystem();
}

void SessionLogger::pushRing(const SensorReading& reading) {
  ring_[ringHead_] = reading;
  ringHead_ = (ringHead_ + 1) % kPretriggerRecords;
  if (ringCount_ < kPretriggerRecords) ++ringCount_;
}

void SessionLogger::addSample(const SensorReading& reading) {
  latestReading_ = reading;
  haveLatestReading_ = true;
  if (!filesystemReady_) {
    retryFilesystem(reading.capturedAtMs);
  }
  if (!probeMappingReady_ || commissioningMode_) return;
  // Keep the idle pre-trigger window in RAM through a transient mount outage.
  // An active session cannot coexist with an unavailable filesystem.
  pushRing(reading);
  if (!filesystemReady_) return;
  if (active_) {
    evaluateActive(reading);
  } else {
    evaluateIdle(reading);
  }
}

void SessionLogger::evaluateIdle(const SensorReading& reading) {
  bool above = false;
  for (uint8_t index = 0; index < kSensorCount; ++index) {
    if ((reading.validMask & (1U << index)) &&
        reading.centiC[index] > kStartCentiC) {
      above = true;
      break;
    }
  }
  if (!above) {
    startCandidate_ = false;
    // A completely failed bus immediately after reboot does not prove that the
    // sauna cooled while power was absent. Only abandon a probable continuation
    // after a representative sensor set has actually reported a cold sample.
    if (bitCount(reading.validMask) >= 6) {
      continuationOf_ = 0;
      continuationKind_ = ContinuationKind::None;
      continuationAnchorAtMs_ = 0;
      hotContinuationEligible_ = false;
    }
    return;
  }
  if (!startCandidate_) {
    startCandidate_ = true;
    aboveStartSinceMs_ = reading.capturedAtMs;
    if (hotContinuationEligible_ && interruptedSessionWasHot_) {
      continuationOf_ = interruptedSessionId_;
      continuationKind_ = ContinuationKind::ProbablePowerRestore;
      continuationAnchorAtMs_ = 0;
    }
    return;
  }
  if (static_cast<uint32_t>(reading.capturedAtMs - aboveStartSinceMs_) >=
      kStartHoldMs) {
    if (!startSession(reading)) {
      Serial.println("logger_event=start_failed");
    }
    startCandidate_ = false;
  }
}

bool SessionLogger::startSession(const SensorReading& trigger) {
  if (!probeMappingReady_ || commissioningMode_) {
    Serial.printf("logger_event=logging_blocked reason=%s\n",
                  commissioningMode_ ? "commissioning" : "not_configured");
    return false;
  }
  const uint32_t previousHighestId = highestSessionId();
  if (previousHighestId == UINT32_MAX) {
    Serial.println("logger_event=start_failed reason=session_id_exhausted");
    return false;
  }
  if (retentionAuditAvailable_ &&
      !recordHighestSessionId(previousHighestId)) {
    retentionAuditAvailable_ = false;
    Serial.println("logger_event=retention_audit_unavailable");
  }
  // Synchronize the existing high-water mark before retention can remove the
  // only on-disk file that carries it. Do not consume a new ID until the
  // reserve succeeds; a full device may retry a hot start many times.
  const uint32_t nextId = previousHighestId + 1;
  if (!reserveForNewSession()) {
    Serial.println("logger_event=logging_blocked reason=insufficient_space");
    return false;
  }
  if (LittleFS.exists(sessionPath(nextId))) {
    Serial.println("logger_event=start_failed reason=session_id_collision");
    return false;
  }
  currentSessionId_ = nextId;
  File file = LittleFS.open(sessionPath(currentSessionId_), FILE_WRITE);
  if (!file) {
    currentSessionId_ = 0;
    return false;
  }

  SessionHeaderV2 header{};
  memcpy(header.magic, kHeaderMagic, sizeof(kHeaderMagic));
  header.version = 2;
  header.headerSize = sizeof(header);
  header.sessionId = currentSessionId_;
  header.sampleIntervalMs = kSampleIntervalMs;
  header.pretriggerMs = kPretriggerRecords * kSampleIntervalMs;
  header.spacingCm = 20;
  header.sensorCount = kSensorCount;
  header.startCentiC = kStartCentiC;
  header.endCentiC = kEndCentiC;
  header.peakDropCentiC = kPeakDropCentiC;
  header.startHoldSeconds = kStartHoldMs / 1000;
  header.endHoldSeconds = kEndHoldMs / 1000;
  header.continuationOf = continuationOf_;
  header.bootId = bootId_;
  header.resetReason = resetReason_;
  ContinuationKind storedContinuationKind = continuationKind_;
  if (storedContinuationKind == ContinuationKind::MaxDurationSampleAnchored) {
    const uint32_t delaySeconds =
        static_cast<uint32_t>(trigger.capturedAtMs - continuationAnchorAtMs_) /
        1000U;
    if (delaySeconds > 0 && delaySeconds <= UINT8_MAX) {
      header.continuationDelaySeconds = static_cast<uint8_t>(delaySeconds);
    } else {
      // Preserve the link, but use the older conservative kind when the
      // measured whole-second delay cannot fit in the v2 header byte.
      storedContinuationKind = ContinuationKind::MaxDuration;
    }
  }
  header.continuationKind = static_cast<uint8_t>(storedContinuationKind);
  header.initialRtcSource = static_cast<uint8_t>(rtc_clk_slow_freq_get());
  header.initialRtcHz = rtc_clk_slow_freq_get_hz();
  for (uint8_t index = 0; index < kSensorCount; ++index) {
    memcpy(header.sensors[index].rom, probeMapping_.roms[index],
           sizeof(header.sensors[index].rom));
    header.sensors[index].relativeHeightCm =
        probeRelativeHeightCm(probeMapping_.geometryId, index);
  }
  header.headerCrc = crc32(reinterpret_cast<const uint8_t*>(&header),
                           sizeof(header) - sizeof(header.headerCrc));
  if (file.write(reinterpret_cast<const uint8_t*>(&header), sizeof(header)) !=
      sizeof(header)) {
    file.close();
    LittleFS.remove(sessionPath(currentSessionId_));
    currentSessionId_ = 0;
    return false;
  }
  file.flush();
  file.close();

  if (retentionAuditAvailable_ && !recordHighestSessionId(currentSessionId_)) {
    // The new header now preserves this ID on disk. Keep recording, but disable
    // automatic retention until its persistent audit can be trusted again.
    retentionAuditAvailable_ = false;
    Serial.println("logger_event=retention_audit_unavailable");
  }

  active_ = true;
  triggerAtMs_ = trigger.capturedAtMs;
  blockSequence_ = 0;
  totalRecords_ = 0;
  pendingCount_ = 0;
  coolingCandidate_ = false;
  sessionPeakCentiC_ = INT16_MIN;

  SensorReading ordered[kPretriggerRecords];
  const uint16_t oldest = (ringHead_ + kPretriggerRecords - ringCount_) %
                          kPretriggerRecords;
  for (uint16_t index = 0; index < ringCount_; ++index) {
    ordered[index] = ring_[(oldest + index) % kPretriggerRecords];
  }
  if (!appendBlock(ordered, ringCount_)) {
    interruptActiveSession("pretrigger_write_failed");
    return false;
  }
  Serial.printf("logger_event=session_started id=%u pretrigger_records=%u\n",
                currentSessionId_, ringCount_);
  continuationOf_ = 0;
  continuationKind_ = ContinuationKind::None;
  continuationAnchorAtMs_ = 0;
  hotContinuationEligible_ = false;
  return true;
}

void SessionLogger::evaluateActive(const SensorReading& reading) {
  pending_[pendingCount_++] = reading;
  int16_t hottest = INT16_MIN;
  for (uint8_t index = 0; index < kSensorCount; ++index) {
    if (reading.validMask & (1U << index)) {
      hottest = max(hottest, reading.centiC[index]);
    }
  }
  if (hottest > sessionPeakCentiC_) sessionPeakCentiC_ = hottest;

  if (pendingCount_ == kRecordsPerBlock && !commitPending()) {
    // A failed append may have left a torn tail. Do not retry the same block or
    // append a footer after it; earlier CRC-complete blocks remain recoverable.
    interruptActiveSession("block_write_failed");
    return;
  }

  const bool healthy = (reading.validMask & 0x01U) &&
                       bitCount(reading.validMask) >= 6;
  const bool cooled = healthy && hottest < kEndCentiC &&
                      hottest <= sessionPeakCentiC_ - kPeakDropCentiC;
  if (!cooled) {
    coolingCandidate_ = false;
  } else if (!coolingCandidate_) {
    coolingCandidate_ = true;
    coolingSinceMs_ = reading.capturedAtMs;
  } else if (static_cast<uint32_t>(reading.capturedAtMs - coolingSinceMs_) >=
             kEndHoldMs) {
    finishSession(FinishReason::NormalCooling,
                  static_cast<int32_t>(reading.capturedAtMs - triggerAtMs_) /
                      1000,
                  reading.capturedAtMs);
    return;
  }

  if (static_cast<uint32_t>(reading.capturedAtMs - triggerAtMs_) >=
      kMaxSessionMs) {
    finishSession(FinishReason::MaxDuration,
                  static_cast<int32_t>(reading.capturedAtMs - triggerAtMs_) /
                      1000,
                  reading.capturedAtMs);
  }
}

bool SessionLogger::appendBlock(const SensorReading* readings, uint16_t count) {
  if (!count) return true;
  StoredRecordV2 records[kRecordsPerBlock];
  for (uint16_t index = 0; index < count; ++index) {
    records[index].relativeSeconds =
        static_cast<int32_t>(readings[index].capturedAtMs - triggerAtMs_) / 1000;
    memcpy(records[index].centiC, readings[index].centiC,
           sizeof(records[index].centiC));
    records[index].validMask = readings[index].validMask;
    records[index].chipCentiC = readings[index].chipCentiC;
    records[index].statusFlags = readings[index].statusFlags;
  }
  BlockHeader block{};
  block.magic = kBlockMagic;
  block.sequence = blockSequence_;
  block.recordCount = count;
  block.payloadBytes = count * sizeof(StoredRecordV2);
  block.payloadCrc = crc32(reinterpret_cast<const uint8_t*>(records),
                           block.payloadBytes);
  File file = LittleFS.open(sessionPath(currentSessionId_), FILE_APPEND);
  if (!file) return false;
  const bool written =
      file.write(reinterpret_cast<const uint8_t*>(&block), sizeof(block)) ==
          sizeof(block) &&
      file.write(reinterpret_cast<const uint8_t*>(records), block.payloadBytes) ==
          block.payloadBytes;
  file.flush();
  file.close();
  if (!written) {
    return false;
  }
  ++blockSequence_;
  totalRecords_ += count;
  return true;
}

bool SessionLogger::commitPending() {
  if (!pendingCount_) return true;
  if (freeBytes() < kBlockWriteReserveBytes) {
    return false;
  }
  if (!appendBlock(pending_, pendingCount_)) return false;
  pendingCount_ = 0;
  Serial.printf("logger_event=block_committed id=%u records=%u\n",
                currentSessionId_, totalRecords_);
  return true;
}

bool SessionLogger::appendFooter(const void* footer, size_t size) {
  File file = LittleFS.open(sessionPath(currentSessionId_), FILE_APPEND);
  if (!file) return false;
  const bool written =
      file.write(reinterpret_cast<const uint8_t*>(footer), size) == size;
  file.flush();
  file.close();
  return written;
}

void SessionLogger::finishSession(FinishReason reason, int32_t finalSeconds,
                                  uint32_t finishedAtMs) {
  if (!active_) return;
  if (!commitPending()) {
    interruptActiveSession("final_block_write_failed");
    return;
  }
  SessionFooter footer{};
  footer.magic = kFooterMagic;
  footer.reason = static_cast<uint8_t>(reason);
  footer.totalRecords = totalRecords_;
  footer.finalRelativeSeconds = finalSeconds;
  footer.footerCrc = crc32(reinterpret_cast<const uint8_t*>(&footer),
                           sizeof(footer) - sizeof(footer.footerCrc));
  if (!appendFooter(&footer, sizeof(footer))) {
    interruptActiveSession("footer_write_failed");
    return;
  }
  const uint32_t finishedId = currentSessionId_;
  Serial.printf("logger_event=session_finished id=%u reason=%u records=%u\n",
                currentSessionId_, static_cast<unsigned>(reason), totalRecords_);
  active_ = false;
  currentSessionId_ = 0;
  if (reason == FinishReason::MaxDuration) {
    continuationOf_ = finishedId;
    continuationKind_ = ContinuationKind::MaxDurationSampleAnchored;
    continuationAnchorAtMs_ = finishedAtMs;
    startCandidate_ = true;
    aboveStartSinceMs_ = finishedAtMs;
  }
}

void SessionLogger::interruptActiveSession(const char* reason) {
  if (!active_) return;
  const uint32_t interruptedId = currentSessionId_;
  Serial.printf("logger_event=session_interrupted id=%u reason=%s\n",
                interruptedId, reason ? reason : "unknown");
  active_ = false;
  pendingCount_ = 0;
  currentSessionId_ = 0;
  interruptedSessionId_ = interruptedId;
  interruptedSessionWasHot_ = true;
  hotContinuationEligible_ = true;
  continuationOf_ = interruptedId;
  continuationKind_ = ContinuationKind::ProbablePowerRestore;
  continuationAnchorAtMs_ = 0;
}

String SessionLogger::sessionPath(uint32_t id) const {
  char path[32];
  snprintf(path, sizeof(path), "/sessions/%08u.slog", id);
  return String(path);
}

uint32_t SessionLogger::highestSessionId() {
  uint32_t highest = retentionHighestSessionId_;
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    uint32_t id = 0;
    if (parseSessionId(String(entry.name()), &id)) highest = max(highest, id);
    entry.close();
  }
  return highest;
}

size_t SessionLogger::freeBytes() const {
  if (!filesystemReady_) return 0;
  const size_t total = LittleFS.totalBytes();
  const size_t used = LittleFS.usedBytes();
  return used <= total ? total - used : 0;
}

bool SessionLogger::reserveForNewSession() {
  static_assert(
      kSessionReserveBytes >=
          kMaximumEncodedSessionBytes + kFilesystemReserveMarginBytes,
      "session reserve cannot hold a maximum run plus filesystem margin");
  retentionCatalogOverflow_ = false;
  retentionCatalogInvalid_ = false;
  retentionRefusal_ = RetentionRefusal::None;
  if (!filesystemReady_ || active_) {
    retentionRefusal_ = RetentionRefusal::DeleteFailed;
    return false;
  }
  // A power cut may have interrupted deletion of a linked run. Complete that
  // run before considering the raw free-space count so retention stays
  // run-granular across reboots.
  if (retentionPendingSegment_) {
    if (!retentionAuditAvailable_) {
      retentionRefusal_ = RetentionRefusal::AuditUnavailable;
      Serial.printf("logger_event=retention_blocked reason=%s\n",
                    retentionRefusalName());
      return false;
    }
    if (!resumePendingRetentionRun()) {
      Serial.printf("logger_event=retention_blocked reason=%s\n",
                    retentionRefusalName());
      return false;
    }
  }
  if (freeBytes() >= kSessionReserveBytes) return true;
  if (!retentionAuditAvailable_ || !reconcilePendingRetention()) {
    retentionRefusal_ = RetentionRefusal::AuditUnavailable;
    Serial.printf("logger_event=retention_blocked reason=%s\n",
                  retentionRefusalName());
    return false;
  }
  while (freeBytes() < kSessionReserveBytes) {
    if (!retireOldestCompleteRun()) {
      Serial.printf("logger_event=retention_blocked reason=%s\n",
                    retentionRefusalName());
      return false;
    }
  }
  return true;
}

bool SessionLogger::resumePendingRetentionRun() {
  if (!retentionPendingSegment_) return true;
  if (!reconcilePendingRetention()) return false;
  if (!retentionPendingSegment_) return true;
  return retireOldestCompleteRun(retentionPendingRun_);
}

bool SessionLogger::readSessionLink(File& file, uint32_t filenameId,
                                    uint16_t* version,
                                    uint32_t* continuationOf) {
  if (!version || !continuationOf) return false;
  struct __attribute__((packed)) HeaderPrefix {
    char magic[8];
    uint16_t version;
    uint16_t headerSize;
  } prefix{};
  file.seek(0);
  if (file.read(reinterpret_cast<uint8_t*>(&prefix), sizeof(prefix)) !=
          sizeof(prefix) ||
      memcmp(prefix.magic, kHeaderMagic, sizeof(kHeaderMagic)) != 0) {
    return false;
  }

  uint32_t sessionId = 0;
  uint32_t linkedId = 0;
  uint8_t headerBytes[sizeof(SessionHeaderV2)]{};
  const size_t expectedSize =
      prefix.version == 1 ? sizeof(SessionHeaderV1)
                          : prefix.version == 2 ? sizeof(SessionHeaderV2) : 0;
  if (!expectedSize || prefix.headerSize != expectedSize) return false;
  file.seek(0);
  if (file.read(headerBytes, expectedSize) != expectedSize) return false;
  uint32_t storedCrc = 0;
  memcpy(&storedCrc, headerBytes + expectedSize - sizeof(storedCrc),
         sizeof(storedCrc));
  if (storedCrc != crc32(headerBytes, expectedSize - sizeof(storedCrc)))
    return false;

  if (prefix.version == 1) {
    SessionHeaderV1 header{};
    memcpy(&header, headerBytes, sizeof(header));
    sessionId = header.sessionId;
    linkedId = header.continuationOf;
  } else {
    SessionHeaderV2 header{};
    memcpy(&header, headerBytes, sizeof(header));
    sessionId = header.sessionId;
    linkedId = header.continuationOf;
  }
  if (!sessionId || sessionId != filenameId) return false;
  *version = prefix.version;
  *continuationOf = linkedId;
  return true;
}

bool SessionLogger::readRetentionSegment(File& file, uint32_t filenameId,
                                         RetentionSegment* segment) {
  if (!segment) return false;
  uint16_t version = 0;
  uint32_t continuationOf = 0;
  if (!readSessionLink(file, filenameId, &version, &continuationOf))
    return false;

  FinishReason reason{};
  const size_t headerSize =
      version == 1 ? sizeof(SessionHeaderV1) : sizeof(SessionHeaderV2);
  const size_t recordSize =
      version == 1 ? sizeof(StoredRecordV1) : sizeof(StoredRecordV2);
  const bool finalized = sessionFinalized(file, &reason);
  RetentionFinishReason retentionReason = RetentionFinishReason::Interrupted;
  if (finalized) {
    if (!finalizedSessionContentsValid(file, headerSize, recordSize, &reason))
      return false;
    switch (reason) {
      case FinishReason::NormalCooling:
        retentionReason = RetentionFinishReason::NormalCooling;
        break;
      case FinishReason::MaxDuration:
        retentionReason = RetentionFinishReason::MaxDuration;
        break;
      case FinishReason::StorageFull:
        retentionReason = RetentionFinishReason::StorageFull;
        break;
      default:
        return false;
    }
  }
  *segment = {filenameId, continuationOf, retentionReason};
  return true;
}

bool SessionLogger::finalizedSessionContentsValid(File& file, size_t headerSize,
                                                   size_t recordSize,
                                                   FinishReason* reason) {
  if (!reason || file.size() < headerSize + sizeof(SessionFooter)) return false;
  const size_t footerOffset = file.size() - sizeof(SessionFooter);
  file.seek(footerOffset);
  SessionFooter footer{};
  if (file.read(reinterpret_cast<uint8_t*>(&footer), sizeof(footer)) !=
          sizeof(footer) ||
      footer.magic != kFooterMagic ||
      footer.footerCrc !=
          crc32(reinterpret_cast<const uint8_t*>(&footer),
                sizeof(footer) - sizeof(footer.footerCrc))) {
    return false;
  }

  uint32_t expectedSequence = 0;
  uint32_t decodedRecords = 0;
  uint32_t decodedBlocks = 0;
  file.seek(headerSize);
  uint8_t buffer[96];
  while (file.position() < footerOffset) {
    if (file.position() + sizeof(BlockHeader) > footerOffset) return false;
    BlockHeader block{};
    if (file.read(reinterpret_cast<uint8_t*>(&block), sizeof(block)) !=
            sizeof(block) ||
        block.magic != kBlockMagic || block.sequence != expectedSequence++ ||
        !block.recordCount || block.recordCount > kRecordsPerBlock ||
        block.payloadBytes != block.recordCount * recordSize ||
        file.position() + block.payloadBytes > footerOffset) {
      return false;
    }
    uint32_t checksum = 0;
    size_t remaining = block.payloadBytes;
    while (remaining) {
      const size_t count = min(sizeof(buffer), remaining);
      if (file.read(buffer, count) != count) return false;
      checksum = crc32(buffer, count, checksum);
      remaining -= count;
    }
    if (checksum != block.payloadCrc) return false;
    ++decodedBlocks;
    decodedRecords += block.recordCount;
  }
  if (!decodedBlocks || !decodedRecords ||
      decodedRecords != footer.totalRecords)
    return false;
  *reason = static_cast<FinishReason>(footer.reason);
  return true;
}

bool SessionLogger::retireOldestCompleteRun(uint32_t requiredRootId) {
  retentionCatalogOverflow_ = false;
  retentionCatalogInvalid_ = false;
  std::unique_ptr<RetentionSegment[]> segments(
      new (std::nothrow) RetentionSegment[kMaxRetentionSegments]);
  std::unique_ptr<RetentionPlan> plan(new (std::nothrow) RetentionPlan{});
  if (!segments || !plan) {
    retentionRefusal_ = RetentionRefusal::AllocationFailed;
    return false;
  }

  size_t count = 0;
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    uint32_t id = 0;
    const bool validName = parseSessionId(String(entry.name()), &id);
    if (!validName || count == kMaxRetentionSegments) {
      retentionCatalogOverflow_ = count == kMaxRetentionSegments;
      retentionCatalogInvalid_ = !retentionCatalogOverflow_;
      retentionRefusal_ = retentionCatalogOverflow_
                              ? RetentionRefusal::CatalogOverflow
                              : RetentionRefusal::CatalogInvalid;
      entry.close();
      directory.close();
      return false;
    }
    if (!readRetentionSegment(entry, id, &segments[count])) {
      retentionCatalogInvalid_ = true;
      retentionRefusal_ = RetentionRefusal::CatalogInvalid;
      entry.close();
      directory.close();
      return false;
    }
    ++count;
    entry.close();
  }
  directory.close();

  if (!retentionCatalogIsValid(segments.get(), count)) {
    retentionCatalogInvalid_ = true;
    retentionRefusal_ = RetentionRefusal::CatalogInvalid;
    return false;
  }

  uint32_t protectedIds[2]{};
  size_t protectedCount = 0;
  if (interruptedSessionId_)
    protectedIds[protectedCount++] = interruptedSessionId_;
  if (continuationOf_ && continuationOf_ != interruptedSessionId_)
    protectedIds[protectedCount++] = continuationOf_;
  if (!planOldestCompleteRun(segments.get(), count, protectedIds,
                             protectedCount, plan.get())) {
    retentionRefusal_ = RetentionRefusal::NoEligibleRun;
    return false;
  }
  if (requiredRootId && plan->rootId != requiredRootId) {
    retentionRefusal_ = RetentionRefusal::PendingRunMismatch;
    return false;
  }

  for (size_t index = 0; index < plan->count; ++index) {
    const uint32_t id = plan->sessionIds[index];
    if (!beginRetentionDeletion(id, plan->rootId)) {
      retentionRefusal_ = RetentionRefusal::AuditUnavailable;
      return false;
    }
    if (!LittleFS.remove(sessionPath(id))) {
      retentionRefusal_ = RetentionRefusal::DeleteFailed;
      return false;
    }
    if (!finishRetentionDeletion(id, plan->rootId)) {
      retentionRefusal_ = RetentionRefusal::AuditUnavailable;
      return false;
    }
    Serial.printf("logger_event=retention_delete id=%u root=%u segments=%u "
                  "runs=%u\n",
                  id, plan->rootId, retentionDeletedSegments_,
                  retentionDeletedRuns_);
  }
  if (!clearRetentionPending()) {
    retentionRefusal_ = RetentionRefusal::AuditUnavailable;
    return false;
  }
  return plan->count > 0;
}

void SessionLogger::loadRetentionState() {
  retentionDeletedRuns_ = 0;
  retentionDeletedSegments_ = 0;
  retentionLastDeletedRun_ = 0;
  retentionLastDeletedSegment_ = 0;
  retentionPendingRun_ = 0;
  retentionPendingSegment_ = 0;
  retentionHighestSessionId_ = 0;
  retentionAuditAvailable_ = false;

  Preferences preferences;
  if (!preferences.begin("sauna", true)) return;
  RetentionAuditV1 audit{};
  const size_t auditLength = preferences.getBytesLength(kRetentionAuditKey);
  const bool auditValid =
      auditLength == sizeof(audit) &&
      preferences.getBytes(kRetentionAuditKey, &audit, sizeof(audit)) ==
          sizeof(audit) &&
      audit.magic == kRetentionAuditMagic &&
      audit.crc == crc32(reinterpret_cast<const uint8_t*>(&audit),
                         sizeof(audit) - sizeof(audit.crc));
  if (auditValid) {
    retentionDeletedRuns_ = audit.deletedRuns;
    retentionDeletedSegments_ = audit.deletedSegments;
    retentionLastDeletedRun_ = audit.lastDeletedRun;
    retentionLastDeletedSegment_ = audit.lastDeletedSegment;
    retentionHighestSessionId_ = audit.highestSessionId;
  }
  RetentionPendingV1 pending{};
  const size_t pendingLength = preferences.getBytesLength(kRetentionPendingKey);
  const bool pendingValid =
      !pendingLength ||
      (pendingLength == sizeof(pending) &&
       preferences.getBytes(kRetentionPendingKey, &pending, sizeof(pending)) ==
           sizeof(pending) &&
       pending.magic == kRetentionPendingMagic &&
       pending.sessionId && pending.rootId &&
       pending.rootId <= pending.sessionId &&
       pending.crc == crc32(reinterpret_cast<const uint8_t*>(&pending),
                            sizeof(pending) - sizeof(pending.crc)));
  if (pendingLength && pendingValid) {
    retentionPendingRun_ = pending.rootId;
    retentionPendingSegment_ = pending.sessionId;
  }
  preferences.end();

  if (auditLength == 0 && pendingLength == 0) {
    retentionAuditAvailable_ = saveRetentionAudit();
  } else {
    retentionAuditAvailable_ = auditValid && pendingValid;
  }
}

bool SessionLogger::saveRetentionAudit() {
  RetentionAuditV1 audit{kRetentionAuditMagic,
                         retentionDeletedRuns_,
                         retentionDeletedSegments_,
                         retentionLastDeletedRun_,
                         retentionLastDeletedSegment_,
                         retentionHighestSessionId_,
                         0};
  audit.crc = crc32(reinterpret_cast<const uint8_t*>(&audit),
                    sizeof(audit) - sizeof(audit.crc));
  Preferences preferences;
  if (!preferences.begin("sauna", false)) return false;
  const bool saved =
      preferences.putBytes(kRetentionAuditKey, &audit, sizeof(audit)) ==
      sizeof(audit);
  preferences.end();
  return saved;
}

bool SessionLogger::recordHighestSessionId(uint32_t sessionId) {
  if (sessionId <= retentionHighestSessionId_) return true;
  const uint32_t previous = retentionHighestSessionId_;
  retentionHighestSessionId_ = sessionId;
  if (saveRetentionAudit()) return true;
  retentionHighestSessionId_ = previous;
  return false;
}

bool SessionLogger::beginRetentionDeletion(uint32_t sessionId,
                                           uint32_t rootId) {
  RetentionPendingV1 pending{kRetentionPendingMagic, sessionId, rootId, 0};
  pending.crc = crc32(reinterpret_cast<const uint8_t*>(&pending),
                      sizeof(pending) - sizeof(pending.crc));
  Preferences preferences;
  if (!preferences.begin("sauna", false)) {
    retentionAuditAvailable_ = false;
    return false;
  }
  const bool saved =
      preferences.putBytes(kRetentionPendingKey, &pending, sizeof(pending)) ==
      sizeof(pending);
  preferences.end();
  if (saved) {
    retentionPendingRun_ = rootId;
    retentionPendingSegment_ = sessionId;
  } else {
    retentionAuditAvailable_ = false;
  }
  return saved;
}

bool SessionLogger::clearRetentionPending() {
  Preferences preferences;
  if (!preferences.begin("sauna", false)) {
    retentionAuditAvailable_ = false;
    return false;
  }
  const bool cleared = preferences.remove(kRetentionPendingKey) ||
                       !preferences.isKey(kRetentionPendingKey);
  preferences.end();
  if (cleared) {
    retentionPendingRun_ = 0;
    retentionPendingSegment_ = 0;
  } else {
    retentionAuditAvailable_ = false;
  }
  return cleared;
}

bool SessionLogger::finishRetentionDeletion(uint32_t sessionId,
                                            uint32_t rootId) {
  if (retentionLastDeletedSegment_ != sessionId) {
    ++retentionDeletedSegments_;
    retentionLastDeletedSegment_ = sessionId;
    if (sessionId == rootId) {
      ++retentionDeletedRuns_;
      retentionLastDeletedRun_ = rootId;
    }
  }

  const bool saved = saveRetentionAudit();
  if (!saved) {
    retentionAuditAvailable_ = false;
    return false;
  }
  return true;
}

bool SessionLogger::reconcilePendingRetention() {
  if (!retentionPendingSegment_) return true;
  if (LittleFS.exists(sessionPath(retentionPendingSegment_))) return true;
  const bool completedRoot = retentionPendingSegment_ == retentionPendingRun_;
  if (!finishRetentionDeletion(retentionPendingSegment_,
                               retentionPendingRun_)) {
    return false;
  }
  return !completedRoot || clearRetentionPending();
}

bool SessionLogger::resetRetentionState() {
  Preferences preferences;
  if (!preferences.begin("sauna", false)) {
    retentionAuditAvailable_ = false;
    return false;
  }
  const bool pendingCleared = preferences.remove(kRetentionPendingKey) ||
                              !preferences.isKey(kRetentionPendingKey);
  preferences.end();
  if (!pendingCleared) return false;

  retentionDeletedRuns_ = 0;
  retentionDeletedSegments_ = 0;
  retentionLastDeletedRun_ = 0;
  retentionLastDeletedSegment_ = 0;
  retentionHighestSessionId_ = 0;
  retentionPendingRun_ = 0;
  retentionPendingSegment_ = 0;
  retentionCatalogOverflow_ = false;
  retentionCatalogInvalid_ = false;
  retentionRefusal_ = RetentionRefusal::None;
  retentionAuditAvailable_ = saveRetentionAudit();
  return retentionAuditAvailable_;
}

const char* SessionLogger::retentionRefusalName() const {
  switch (retentionRefusal_) {
    case RetentionRefusal::None:
      return "none";
    case RetentionRefusal::CatalogOverflow:
      return "catalog_overflow";
    case RetentionRefusal::CatalogInvalid:
      return "catalog_invalid";
    case RetentionRefusal::NoEligibleRun:
      return "no_eligible_run";
    case RetentionRefusal::AuditUnavailable:
      return "audit_unavailable";
    case RetentionRefusal::AllocationFailed:
      return "allocation_failed";
    case RetentionRefusal::DeleteFailed:
      return "delete_failed";
    case RetentionRefusal::PendingRunMismatch:
      return "pending_run_mismatch";
  }
  return "unknown";
}

void SessionLogger::findInterruptedSession() {
  interruptedSessionId_ = 0;
  interruptedSessionWasHot_ = false;
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    const String name = entry.name();
    const int slash = name.lastIndexOf('/');
    const uint32_t id = strtoul(name.substring(slash + 1).c_str(), nullptr, 10);
    if (id > interruptedSessionId_ && !sessionFinalized(entry)) {
      interruptedSessionId_ = id;
      interruptedSessionWasHot_ = sessionEndsHot(entry);
    }
    entry.close();
  }
  hotContinuationEligible_ = interruptedSessionWasHot_;
}

bool SessionLogger::sessionLayoutMatches(const uint8_t* headerBytes,
                                         uint16_t version) const {
  if (!probeMappingReady_ || !headerBytes) return false;
  SensorDescriptor descriptors[kSensorCount]{};
  int16_t spacingCm = 0;
  uint8_t sensorCount = 0;
  if (version == 1) {
    SessionHeaderV1 header{};
    memcpy(&header, headerBytes, sizeof(header));
    spacingCm = header.spacingCm;
    sensorCount = header.sensorCount;
    memcpy(descriptors, header.sensors, sizeof(descriptors));
  } else if (version == 2) {
    SessionHeaderV2 header{};
    memcpy(&header, headerBytes, sizeof(header));
    spacingCm = header.spacingCm;
    sensorCount = header.sensorCount;
    memcpy(descriptors, header.sensors, sizeof(descriptors));
  } else {
    return false;
  }
  if (spacingCm != 20 || sensorCount != kSensorCount) return false;
  for (uint8_t index = 0; index < kSensorCount; ++index) {
    if (memcmp(descriptors[index].rom, probeMapping_.roms[index],
               sizeof(descriptors[index].rom)) != 0 ||
        descriptors[index].relativeHeightCm !=
            probeRelativeHeightCm(probeMapping_.geometryId, index)) {
      return false;
    }
  }
  return true;
}

bool SessionLogger::sessionEndsHot(File& file) {
  struct __attribute__((packed)) HeaderPrefix {
    char magic[8];
    uint16_t version;
    uint16_t headerSize;
  } prefix{};
  file.seek(0);
  if (file.read(reinterpret_cast<uint8_t*>(&prefix), sizeof(prefix)) !=
          sizeof(prefix) ||
      memcmp(prefix.magic, kHeaderMagic, sizeof(kHeaderMagic)) != 0 ||
      (prefix.version != 1 && prefix.version != 2) ||
      prefix.headerSize > sizeof(SessionHeaderV2) ||
      prefix.headerSize < sizeof(prefix) + sizeof(uint32_t)) {
    return false;
  }
  uint8_t headerBytes[sizeof(SessionHeaderV2)]{};
  file.seek(0);
  if (file.read(headerBytes, prefix.headerSize) != prefix.headerSize) return false;
  uint32_t storedHeaderCrc = 0;
  memcpy(&storedHeaderCrc, headerBytes + prefix.headerSize - sizeof(uint32_t),
         sizeof(storedHeaderCrc));
  if (storedHeaderCrc !=
      crc32(headerBytes, prefix.headerSize - sizeof(storedHeaderCrc))) {
    return false;
  }
  if (!sessionLayoutMatches(headerBytes, prefix.version)) return false;

  const size_t recordSize = prefix.version == 1 ? sizeof(StoredRecordV1)
                                                 : sizeof(StoredRecordV2);
  int16_t lastHottest = INT16_MIN;
  file.seek(prefix.headerSize);
  while (file.position() + sizeof(BlockHeader) <= file.size()) {
    const size_t position = file.position();
    uint32_t magic = 0;
    if (file.read(reinterpret_cast<uint8_t*>(&magic), sizeof(magic)) !=
        sizeof(magic))
      break;
    if (magic == kFooterMagic) break;
    file.seek(position);
    BlockHeader block{};
    if (file.read(reinterpret_cast<uint8_t*>(&block), sizeof(block)) !=
            sizeof(block) ||
        block.magic != kBlockMagic || block.recordCount > kRecordsPerBlock ||
        block.payloadBytes != block.recordCount * recordSize ||
        file.position() + block.payloadBytes > file.size()) {
      break;
    }
    uint8_t payload[kRecordsPerBlock * sizeof(StoredRecordV2)]{};
    if (file.read(payload, block.payloadBytes) != block.payloadBytes ||
        crc32(payload, block.payloadBytes) != block.payloadCrc) {
      break;
    }
    for (uint16_t index = 0; index < block.recordCount; ++index) {
      const uint8_t* raw = payload + index * recordSize;
      const uint8_t validMask = raw[sizeof(int32_t) + sizeof(int16_t) * kSensorCount];
      int16_t hottest = INT16_MIN;
      for (uint8_t sensor = 0; sensor < kSensorCount; ++sensor) {
        int16_t temperature = 0;
        memcpy(&temperature,
               raw + sizeof(int32_t) + sensor * sizeof(int16_t),
               sizeof(temperature));
        if (validMask & (1U << sensor)) hottest = max(hottest, temperature);
      }
      lastHottest = hottest;
    }
  }
  return lastHottest > kStartCentiC;
}

bool SessionLogger::sessionFinalized(File& file, FinishReason* reason) {
  if (file.size() < sizeof(SessionFooter)) return false;
  file.seek(file.size() - sizeof(SessionFooter));
  SessionFooter footer{};
  if (file.read(reinterpret_cast<uint8_t*>(&footer), sizeof(footer)) !=
      sizeof(footer)) return false;
  const bool valid = footer.magic == kFooterMagic &&
                     footer.footerCrc ==
                         crc32(reinterpret_cast<const uint8_t*>(&footer),
                               sizeof(footer) - sizeof(footer.footerCrc));
  if (valid && reason) *reason = static_cast<FinishReason>(footer.reason);
  return valid;
}

void SessionLogger::handleSerial(ExtraCommandHandler extraHandler) {
  while (Serial.available()) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\n' || character == '\r') {
      if (serialLineOverflow_) {
        Serial.println("SYS_ERROR code=command_too_long");
        serialLineOverflow_ = false;
        serialLine_ = "";
      } else if (serialLine_.length()) {
        // Autonomous diagnostics such as TELEM are deliberately best-effort.
        // If USB CDC drops the tail of one while the host opens the port, its
        // newline can disappear too.  Start every solicited response at a
        // fresh boundary so a valid response can never be joined to that
        // truncated chatter and become invisible to a line-oriented client.
        Serial.println();
        bool handled = processCommand(serialLine_);
        if (!handled && extraHandler) handled = extraHandler(serialLine_);
        if (!handled) Serial.println("LOG_ERROR unknown_command");
        serialLine_ = "";
      }
    } else if (!serialLineOverflow_ && serialLine_.length() < 127) {
      serialLine_ += character;
    } else {
      serialLineOverflow_ = true;
      serialLine_ = "";
    }
  }
}

bool SessionLogger::processCommand(const String& command) {
  if (command == "LOG STATUS") {
    printStatus();
  } else if (command == "LOG LIST") {
    listSessions();
  } else if (command.startsWith("LOG GET ")) {
    downloadSession(strtoul(command.substring(8).c_str(), nullptr, 10));
  } else if (command.startsWith("LOG DELETE ")) {
    if (active_) {
      Serial.println("LOG_ERROR active_session");
    } else {
      const uint32_t id = strtoul(command.substring(11).c_str(), nullptr, 10);
      Serial.printf("LOG_DELETE id=%u ok=%u\n", id, deleteSession(id));
    }
  } else if (command == "LOG CRASH GET") {
    downloadCoreDump();
  } else if (command == "LOG CRASH ERASE YES") {
    Serial.printf("LOG_CRASH_ERASE ok=%u\n",
                  esp_core_dump_image_erase() == ESP_OK);
  } else if (command == "LOG FORMAT YES") {
    if (active_) {
      Serial.println("LOG_ERROR active_session");
    } else {
      LittleFS.end();
      const bool formatted = LittleFS.format();
      filesystemReady_ = formatted && LittleFS.begin(false);
      bool retentionReset = false;
      if (filesystemReady_) {
        LittleFS.mkdir("/sessions");
        retentionReset = resetRetentionState();
        ringHead_ = 0;
        ringCount_ = 0;
        pendingCount_ = 0;
        startCandidate_ = false;
        coolingCandidate_ = false;
        continuationOf_ = 0;
        continuationKind_ = ContinuationKind::None;
        continuationAnchorAtMs_ = 0;
        hotContinuationEligible_ = false;
        findInterruptedSession();
      }
      Serial.printf("LOG_FORMAT ok=%u retention_reset=%u\n", filesystemReady_,
                    retentionReset);
    }
  } else {
    return false;
  }
  return true;
}

void SessionLogger::printStatus() {
  size_t coreDumpAddress = 0;
  size_t coreDumpSize = 0;
  const bool coreDumpValid =
      esp_core_dump_image_check() == ESP_OK &&
      esp_core_dump_image_get(&coreDumpAddress, &coreDumpSize) == ESP_OK;
  const uint8_t validSensors =
      haveLatestReading_ ? bitCount(latestReading_.validMask) : 0;
  const int chipCentiC =
      haveLatestReading_ &&
              (latestReading_.statusFlags & ChipTemperatureValid)
          ? latestReading_.chipCentiC
          : INT16_MIN;
  const size_t available = freeBytes();
  const uint32_t continuationPendingId =
      continuationOf_ ? continuationOf_
                      : (hotContinuationEligible_ ? interruptedSessionId_ : 0);
  Serial.printf("LOG_STATUS fs=%u active=%u id=%u total=%u used=%u free=%u "
                "boot=%u reset=%u sensors=%u chip_centi_c=%d rtc_source=%u "
                "rtc_hz=%u interrupted=%u continuation_pending=%u coredump=%u "
                "coredump_bytes=%u "
                "retention=rolling reserve_ok=%u reserve_required=%u "
                "retention_deleted_runs=%u retention_deleted_segments=%u "
                "retention_last_run=%u retention_last_segment=%u "
                "retention_pending=%u retention_pending_root=%u "
                "retention_highest_session=%u retention_catalog_overflow=%u "
                "retention_catalog_invalid=%u retention_audit_ok=%u "
                "retention_last_refusal=%s protocol=1 config_state=%s "
                "config_generation=%u active_generation=%u geometry=%s "
                "discovered=%u mapped_valid=%u commissioning=%u "
                "restart_required=%u valid_slots=%u\n",
                filesystemReady_, active_, currentSessionId_,
                filesystemReady_ ? LittleFS.totalBytes() : 0,
                filesystemReady_ ? LittleFS.usedBytes() : 0,
                static_cast<unsigned>(available),
                bootId_, resetReason_, validSensors, chipCentiC,
                static_cast<unsigned>(rtc_clk_slow_freq_get()),
                rtc_clk_slow_freq_get_hz(), interruptedSessionId_,
                continuationPendingId,
                coreDumpValid,
                coreDumpValid ? static_cast<unsigned>(coreDumpSize) : 0,
                filesystemReady_ && available >= kSessionReserveBytes,
                static_cast<unsigned>(kSessionReserveBytes),
                retentionDeletedRuns_, retentionDeletedSegments_,
                retentionLastDeletedRun_, retentionLastDeletedSegment_,
                retentionPendingSegment_, retentionPendingRun_,
                retentionHighestSessionId_, retentionCatalogOverflow_,
                retentionCatalogInvalid_, retentionAuditAvailable_,
                retentionRefusalName(), probeConfigWireState(probeConfigState_),
                storedProbeConfigGeneration_,
                probeMappingReady_ ? probeMapping_.generation : 0,
                probeMappingReady_ ? "column8_20cm_v1" : "none",
                discoveredProbes_, mappedValidProbes_, commissioningMode_,
                probeConfigRestartRequired_, probeConfigValidSlots_);
}

void SessionLogger::listSessions() {
  if (!filesystemReady_) {
    Serial.println("LOG_ERROR fs_unavailable");
    return;
  }
  Serial.println("LOG_LIST_BEGIN");
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    String name = entry.name();
    const int slash = name.lastIndexOf('/');
    const uint32_t id = strtoul(name.substring(slash + 1).c_str(), nullptr, 10);
    FinishReason reason{};
    const bool finalized = sessionFinalized(entry, &reason);
    uint16_t version = 0;
    uint32_t continuationOf = 0;
    uint32_t bootId = 0;
    uint8_t resetReason = 0;
    uint8_t continuationKind = 0;
    entry.seek(0);
    SessionHeaderV2 header{};
    const size_t read = entry.read(reinterpret_cast<uint8_t*>(&header), sizeof(header));
    if (read >= 12 && memcmp(header.magic, kHeaderMagic, sizeof(kHeaderMagic)) == 0) {
      version = header.version;
      if (version == 2 && read == sizeof(header)) {
        continuationOf = header.continuationOf;
        bootId = header.bootId;
        resetReason = header.resetReason;
        continuationKind = header.continuationKind;
      } else if (version == 1) {
        entry.seek(0);
        SessionHeaderV1 oldHeader{};
        if (entry.read(reinterpret_cast<uint8_t*>(&oldHeader), sizeof(oldHeader)) ==
            sizeof(oldHeader))
          continuationOf = oldHeader.continuationOf;
      }
    }
    Serial.printf("LOG_SESSION id=%u bytes=%u state=%s reason=%u version=%u "
                  "boot=%u reset=%u continuation_of=%u continuation_kind=%u\n", id,
                  static_cast<unsigned>(entry.size()),
                  finalized ? "finalized" : "interrupted",
                  finalized ? static_cast<unsigned>(reason) : 0, version, bootId,
                  resetReason, continuationOf, continuationKind);
    entry.close();
  }
  Serial.println("LOG_LIST_END");
}

void SessionLogger::downloadSession(uint32_t id) {
  // A hex transfer is synchronous and can occupy the serial loop for long
  // enough to disturb acquisition timing. Keep every raw transfer out of an
  // active measurement, including transfers of older immutable sessions.
  if (!filesystemReady_ || active_) {
    Serial.println("LOG_ERROR unavailable_or_active");
    return;
  }
  File file = LittleFS.open(sessionPath(id), FILE_READ);
  if (!file) {
    Serial.println("LOG_ERROR not_found");
    return;
  }
  uint32_t checksum = 0;
  uint8_t buffer[48];
  while (file.available()) {
    const size_t count = file.read(buffer, sizeof(buffer));
    checksum = crc32(buffer, count, checksum);
  }
  Serial.printf("LOG_DATA_BEGIN id=%u bytes=%u crc32=%08X\n", id,
                static_cast<unsigned>(file.size()), checksum);
  file.seek(0);
  while (file.available()) {
    const size_t count = file.read(buffer, sizeof(buffer));
    Serial.print("LOG_DATA ");
    for (size_t index = 0; index < count; ++index) {
      if (buffer[index] < 16) Serial.print('0');
      Serial.print(buffer[index], HEX);
    }
    Serial.println();
  }
  Serial.printf("LOG_DATA_END id=%u\n", id);
  file.close();
}

void SessionLogger::downloadCoreDump() {
  size_t address = 0;
  size_t size = 0;
  if (esp_core_dump_image_check() != ESP_OK ||
      esp_core_dump_image_get(&address, &size) != ESP_OK || !size) {
    Serial.println("LOG_ERROR no_valid_coredump");
    return;
  }
  const esp_partition_t* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  if (!partition || size > partition->size) {
    Serial.println("LOG_ERROR invalid_coredump_partition");
    return;
  }
  uint8_t buffer[48];
  uint32_t checksum = 0;
  for (size_t offset = 0; offset < size; offset += sizeof(buffer)) {
    const size_t count = min(sizeof(buffer), size - offset);
    if (esp_partition_read(partition, offset, buffer, count) != ESP_OK) {
      Serial.println("LOG_ERROR coredump_read_failed");
      return;
    }
    checksum = crc32(buffer, count, checksum);
  }
  Serial.printf("LOG_CRASH_BEGIN bytes=%u crc32=%08X\n",
                static_cast<unsigned>(size), checksum);
  for (size_t offset = 0; offset < size; offset += sizeof(buffer)) {
    const size_t count = min(sizeof(buffer), size - offset);
    if (esp_partition_read(partition, offset, buffer, count) != ESP_OK) {
      Serial.println("LOG_ERROR coredump_read_failed");
      return;
    }
    Serial.print("LOG_CRASH_DATA ");
    for (size_t index = 0; index < count; ++index) {
      if (buffer[index] < 16) Serial.print('0');
      Serial.print(buffer[index], HEX);
    }
    Serial.println();
  }
  Serial.println("LOG_CRASH_END");
}

bool SessionLogger::deleteSession(uint32_t id) {
  if (!filesystemReady_ || (active_ && id == currentSessionId_)) return false;
  if (retentionPendingSegment_) return false;
  // The next segment has not written its header yet. Removing this parent
  // would silently discard the only durable link for a max-duration or
  // probable-power continuation.
  const uint32_t continuationPendingId =
      continuationOf_ ? continuationOf_
                      : (hotContinuationEligible_ ? interruptedSessionId_ : 0);
  if (id && continuationPendingId == id) return false;
  if (!id || !LittleFS.exists(sessionPath(id))) return false;

  // Refuse to orphan a continuation. Linked runs can still be removed
  // explicitly, but only from newest segment toward the root.
  File directory = LittleFS.open("/sessions");
  if (!directory) return false;
  File entry;
  while ((entry = directory.openNextFile())) {
    uint32_t filenameId = 0;
    uint16_t version = 0;
    uint32_t continuationOf = 0;
    if (!parseSessionId(String(entry.name()), &filenameId)) {
      entry.close();
      directory.close();
      return false;
    }
    if (filenameId == id) {
      entry.close();
      continue;
    }
    const bool valid =
        readSessionLink(entry, filenameId, &version, &continuationOf);
    entry.close();
    if (!valid || continuationOf == id) {
      directory.close();
      return false;
    }
  }
  directory.close();
  const bool removed = LittleFS.remove(sessionPath(id));
  if (removed && interruptedSessionId_ == id) {
    interruptedSessionId_ = 0;
    interruptedSessionWasHot_ = false;
  }
  return removed;
}

}  // namespace sauna
