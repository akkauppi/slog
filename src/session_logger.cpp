#include "session_logger.h"

#include <LittleFS.h>
#include <Preferences.h>
#include <esp_core_dump.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <soc/rtc.h>

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
  uint8_t reserved2;
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

static_assert(sizeof(SessionHeaderV1) == 130, "v1 log header layout changed");
static_assert(sizeof(SessionHeaderV2) == 142, "v2 log header layout changed");
static_assert(sizeof(StoredRecordV1) == 21, "v1 record layout changed");
static_assert(sizeof(StoredRecordV2) == 25, "v2 record layout changed");
static_assert(sizeof(SessionFooter) == 20, "log footer layout changed");

constexpr SensorDescriptor kDescriptors[kSensorCount] = {
    {{0x28, 0x25, 0xE1, 0xBD, 0, 0, 0, 0x58}, 0},
    {{0x28, 0x56, 0xBE, 0x53, 0, 0, 0, 0x3F}, -20},
    {{0x28, 0x7C, 0x38, 0xC0, 0, 0, 0, 0x78}, -40},
    {{0x28, 0xD9, 0x2E, 0x50, 0, 0, 0, 0xCE}, -60},
    {{0x28, 0x9A, 0xBC, 0x52, 0, 0, 0, 0xD1}, -80},
    {{0x28, 0xCD, 0x19, 0x52, 0, 0, 0, 0x9B}, -100},
    {{0x28, 0x93, 0x93, 0x52, 0, 0, 0, 0xD0}, -120},
    {{0x28, 0x01, 0xF3, 0x52, 0, 0, 0, 0x1E}, -140},
};

uint8_t bitCount(uint8_t value) {
  uint8_t count = 0;
  while (value) {
    count += value & 1;
    value >>= 1;
  }
  return count;
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

bool SessionLogger::begin() {
  resetReason_ = static_cast<uint8_t>(esp_reset_reason());
  Preferences preferences;
  if (preferences.begin("sauna", false)) {
    bootId_ = preferences.getUInt("boot_id", 0) + 1;
    preferences.putUInt("boot_id", bootId_);
    preferences.end();
  }
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
  findInterruptedSession();
  ensureReserve();
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
  pushRing(reading);
  latestReading_ = reading;
  haveLatestReading_ = true;
  if (!filesystemReady_) {
    retryFilesystem(reading.capturedAtMs);
    if (!filesystemReady_) return;
  }
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
  if (!ensureReserve()) {
    Serial.println("logger_event=logging_blocked reason=insufficient_space");
    return false;
  }
  currentSessionId_ = nextSessionId();
  File file = LittleFS.open(sessionPath(currentSessionId_), FILE_WRITE);
  if (!file) return false;

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
  header.continuationKind = static_cast<uint8_t>(continuationKind_);
  header.initialRtcSource = static_cast<uint8_t>(rtc_clk_slow_freq_get());
  header.initialRtcHz = rtc_clk_slow_freq_get_hz();
  memcpy(header.sensors, kDescriptors, sizeof(kDescriptors));
  header.headerCrc = crc32(reinterpret_cast<const uint8_t*>(&header),
                           sizeof(header) - sizeof(header.headerCrc));
  if (file.write(reinterpret_cast<const uint8_t*>(&header), sizeof(header)) !=
      sizeof(header)) {
    file.close();
    LittleFS.remove(sessionPath(currentSessionId_));
    return false;
  }
  file.flush();
  file.close();

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
    active_ = false;
    return false;
  }
  Serial.printf("logger_event=session_started id=%u pretrigger_records=%u\n",
                currentSessionId_, ringCount_);
  continuationOf_ = 0;
  continuationKind_ = ContinuationKind::None;
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
    finishSession(FinishReason::StorageFull,
                  static_cast<int32_t>(reading.capturedAtMs - triggerAtMs_) /
                      1000);
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
                      1000);
    return;
  }

  if (static_cast<uint32_t>(reading.capturedAtMs - triggerAtMs_) >=
      kMaxSessionMs) {
    finishSession(FinishReason::MaxDuration,
                  static_cast<int32_t>(reading.capturedAtMs - triggerAtMs_) /
                      1000);
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
  block.sequence = blockSequence_++;
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
  totalRecords_ += count;
  return true;
}

bool SessionLogger::commitPending() {
  if (!pendingCount_) return true;
  if (LittleFS.totalBytes() - LittleFS.usedBytes() < 8192 &&
      !deleteOldest(currentSessionId_)) {
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

void SessionLogger::finishSession(FinishReason reason, int32_t finalSeconds) {
  if (!active_) return;
  if (!commitPending()) {
    Serial.printf("logger_event=session_interrupted id=%u reason=write_failed\n",
                  currentSessionId_);
    active_ = false;
    interruptedSessionId_ = currentSessionId_;
    interruptedSessionWasHot_ = true;
    currentSessionId_ = 0;
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
    Serial.printf("logger_event=session_interrupted id=%u reason=footer_failed\n",
                  currentSessionId_);
    active_ = false;
    interruptedSessionId_ = currentSessionId_;
    interruptedSessionWasHot_ = true;
    currentSessionId_ = 0;
    return;
  }
  const uint32_t finishedId = currentSessionId_;
  Serial.printf("logger_event=session_finished id=%u reason=%u records=%u\n",
                currentSessionId_, static_cast<unsigned>(reason), totalRecords_);
  active_ = false;
  currentSessionId_ = 0;
  if (reason == FinishReason::MaxDuration) {
    continuationOf_ = finishedId;
    continuationKind_ = ContinuationKind::MaxDuration;
    startCandidate_ = true;
    aboveStartSinceMs_ = millis();
  }
  ensureReserve();
}

String SessionLogger::sessionPath(uint32_t id) const {
  char path[32];
  snprintf(path, sizeof(path), "/sessions/%08u.slog", id);
  return String(path);
}

uint32_t SessionLogger::nextSessionId() {
  uint32_t highest = 0;
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    String name = entry.name();
    const int slash = name.lastIndexOf('/');
    const uint32_t id = strtoul(name.substring(slash + 1).c_str(), nullptr, 10);
    highest = max(highest, id);
    entry.close();
  }
  return highest + 1;
}

bool SessionLogger::deleteOldest(uint32_t excludeId) {
  uint32_t oldest = UINT32_MAX;
  File directory = LittleFS.open("/sessions");
  File entry;
  while ((entry = directory.openNextFile())) {
    String name = entry.name();
    const int slash = name.lastIndexOf('/');
    const uint32_t id = strtoul(name.substring(slash + 1).c_str(), nullptr, 10);
    if (id && id != excludeId && id < oldest) oldest = id;
    entry.close();
  }
  if (oldest == UINT32_MAX) return false;
  Serial.printf("logger_event=retention_delete id=%u\n", oldest);
  return LittleFS.remove(sessionPath(oldest));
}

bool SessionLogger::ensureReserve() {
  if (!filesystemReady_) return false;
  while (LittleFS.totalBytes() - LittleFS.usedBytes() < kMinFreeBytes) {
    if (!deleteOldest(active_ ? currentSessionId_ : 0)) return false;
  }
  return true;
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

void SessionLogger::handleSerial() {
  while (Serial.available()) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\n' || character == '\r') {
      if (serialLine_.length()) {
        processCommand(serialLine_);
        serialLine_ = "";
      }
    } else if (serialLine_.length() < 96) {
      serialLine_ += character;
    }
  }
}

void SessionLogger::processCommand(const String& command) {
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
      if (filesystemReady_) {
        LittleFS.mkdir("/sessions");
        findInterruptedSession();
      }
      Serial.printf("LOG_FORMAT ok=%u\n", filesystemReady_);
    }
  } else {
    Serial.println("LOG_ERROR unknown_command");
  }
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
  Serial.printf("LOG_STATUS fs=%u active=%u id=%u total=%u used=%u free=%u "
                "boot=%u reset=%u sensors=%u chip_centi_c=%d rtc_source=%u "
                "rtc_hz=%u interrupted=%u coredump=%u coredump_bytes=%u\n",
                filesystemReady_, active_, currentSessionId_,
                filesystemReady_ ? LittleFS.totalBytes() : 0,
                filesystemReady_ ? LittleFS.usedBytes() : 0,
                filesystemReady_ ? LittleFS.totalBytes() - LittleFS.usedBytes()
                                 : 0,
                bootId_, resetReason_, validSensors, chipCentiC,
                static_cast<unsigned>(rtc_clk_slow_freq_get()),
                rtc_clk_slow_freq_get_hz(), interruptedSessionId_, coreDumpValid,
                coreDumpValid ? static_cast<unsigned>(coreDumpSize) : 0);
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
  if (!filesystemReady_ || (active_ && id == currentSessionId_)) {
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
  return LittleFS.remove(sessionPath(id));
}

}  // namespace sauna
