#pragma once

#include <Arduino.h>
#include <FS.h>

namespace sauna {

constexpr uint8_t kSensorCount = 8;
constexpr uint32_t kSampleIntervalMs = 10000;
constexpr uint16_t kRecordsPerBlock = 60;

struct SensorReading {
  uint32_t capturedAtMs;
  int16_t centiC[kSensorCount];
  uint8_t validMask;
  int16_t chipCentiC;
  uint16_t statusFlags;
};

enum ReadingStatus : uint16_t {
  ChipTemperatureValid = 1U << 0,
  RtcExternalCrystalActive = 1U << 1,
  RtcCrystalFallbackObserved = 1U << 2,
  SensorSetDegraded = 1U << 3,
};

enum class FinishReason : uint8_t {
  NormalCooling = 1,
  MaxDuration = 2,
  StorageFull = 3,
};

enum class ContinuationKind : uint8_t {
  None = 0,
  MaxDuration = 1,
  ProbablePowerRestore = 2,
};

class SessionLogger {
 public:
  bool begin();
  void addSample(const SensorReading& reading);
  void handleSerial();
  bool filesystemReady() const { return filesystemReady_; }
  bool active() const { return active_; }

 private:
  static constexpr uint16_t kPretriggerRecords = 60;
  static constexpr uint32_t kMinFreeBytes = 128 * 1024;
  static constexpr int16_t kStartCentiC = 4000;
  static constexpr int16_t kEndCentiC = 4500;
  static constexpr int16_t kPeakDropCentiC = 1500;
  static constexpr uint32_t kStartHoldMs = 30000;
  static constexpr uint32_t kEndHoldMs = 30UL * 60UL * 1000UL;
  static constexpr uint32_t kMaxSessionMs = 12UL * 60UL * 60UL * 1000UL;
  static constexpr uint32_t kFilesystemRetryMs = 60UL * 1000UL;

  SensorReading ring_[kPretriggerRecords]{};
  uint16_t ringHead_ = 0;
  uint16_t ringCount_ = 0;
  SensorReading pending_[kRecordsPerBlock]{};
  uint16_t pendingCount_ = 0;
  uint32_t blockSequence_ = 0;
  uint32_t totalRecords_ = 0;
  uint32_t currentSessionId_ = 0;
  uint32_t continuationOf_ = 0;
  uint32_t interruptedSessionId_ = 0;
  uint32_t bootId_ = 0;
  uint32_t triggerAtMs_ = 0;
  uint32_t aboveStartSinceMs_ = 0;
  uint32_t coolingSinceMs_ = 0;
  int16_t sessionPeakCentiC_ = INT16_MIN;
  bool startCandidate_ = false;
  bool coolingCandidate_ = false;
  bool filesystemReady_ = false;
  bool active_ = false;
  bool hotContinuationEligible_ = true;
  bool interruptedSessionWasHot_ = false;
  bool haveLatestReading_ = false;
  uint32_t nextFilesystemRetryAt_ = 0;
  uint8_t resetReason_ = 0;
  ContinuationKind continuationKind_ = ContinuationKind::None;
  SensorReading latestReading_{};
  String serialLine_;

  void pushRing(const SensorReading& reading);
  void evaluateIdle(const SensorReading& reading);
  void evaluateActive(const SensorReading& reading);
  bool startSession(const SensorReading& trigger);
  void finishSession(FinishReason reason, int32_t finalSeconds);
  bool commitPending();
  bool appendBlock(const SensorReading* readings, uint16_t count);
  bool appendFooter(const void* footer, size_t size);
  bool mountFilesystem();
  void retryFilesystem(uint32_t now);
  void findInterruptedSession();
  bool sessionEndsHot(File& file);
  bool ensureReserve();
  bool deleteOldest(uint32_t excludeId = 0);
  uint32_t nextSessionId();
  String sessionPath(uint32_t id) const;
  void processCommand(const String& command);
  void printStatus();
  void listSessions();
  void downloadSession(uint32_t id);
  void downloadCoreDump();
  bool deleteSession(uint32_t id);
  bool sessionFinalized(File& file, FinishReason* reason = nullptr);
};

uint32_t crc32(const uint8_t* data, size_t length, uint32_t initial = 0);

}  // namespace sauna
