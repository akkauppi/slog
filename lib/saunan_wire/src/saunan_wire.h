#pragma once

#include <array>
#include <stddef.h>
#include <stdint.h>

namespace sauna_wire {

constexpr size_t kChannelCapacity = 8;
constexpr size_t kMinimumEnvelopeBytes = 20;
constexpr size_t kSampleV1Bytes = 84;
constexpr size_t kMaximumDatagramBytes = 250;
constexpr uint8_t kSchemaV1 = 1;
constexpr uint8_t kLiveSampleMessage = 1;
constexpr uint16_t kGeometryColumn8At20Cm = 1;
constexpr int16_t kInvalidTemperature = INT16_MIN;

enum StatusFlag : uint16_t {
  kChipTemperatureValid = 1U << 0,
  kRtcExternalCrystalActive = 1U << 1,
  kRtcCrystalFallbackObserved = 1U << 2,
  kSensorSetDegraded = 1U << 3,
  kBootCounterValid = 1U << 4,
  kMappingReady = 1U << 5,
  kStorageReady = 1U << 6,
  kSessionActive = 1U << 7,
  kColdStandby = 1U << 9,  // Cold checks every 150 s; heartbeat every 900 s.
  kStandbyTest = 1U << 10, // With kColdStandby: heartbeat every 300 s.
  kSyntheticSample = 1U << 8,  // Explicit bench data; never a stored measurement.
};

constexpr uint16_t kKnownStatusFlags =
    kChipTemperatureValid | kRtcExternalCrystalActive |
    kRtcCrystalFallbackObserved | kSensorSetDegraded |
    kBootCounterValid | kMappingReady | kStorageReady | kSessionActive |
    kSyntheticSample | kColdStandby | kStandbyTest;

struct Envelope {
  uint8_t schemaMajor = 0;
  uint8_t messageType = 0;
  uint16_t totalBytes = 0;
  uint64_t sourceId = 0;
};

struct SampleV1 {
  uint64_t sourceId = 0;
  uint64_t bootNonce = 0;
  uint32_t bootCounter = 0;
  uint32_t sequence = 0;
  uint64_t senderMonotonicMs = 0;
  uint32_t recordingSessionId = 0;
  uint32_t mappingGeneration = 0;
  uint16_t geometryId = 0;
  uint16_t nominalPeriodMs = 0;
  uint16_t statusFlags = 0;
  uint8_t validMask = 0;
  uint8_t expectedProbeCount = 0;
  std::array<int16_t, kChannelCapacity> centiC{};
  int16_t chipCentiC = kInvalidTemperature;
  uint32_t skippedScheduleCount = 0;

  uint8_t expectedMask() const;
  bool bootCounterValid() const;
  bool standby() const { return (statusFlags & kColdStandby) != 0; }
  uint32_t samplePeriodMs() const { return standby() ? 150000U : nominalPeriodMs; }
  uint32_t transmitPeriodMs() const {
    return standby() ? ((statusFlags & kStandbyTest) ? 300000U : 900000U) : nominalPeriodMs;
  }
};

enum class DecodeError : uint8_t {
  kNone,
  kNullData,
  kEnvelopeTooShort,
  kDatagramTooLong,
  kBadMagic,
  kLengthMismatch,
  kBadCrc,
  kUnsupportedSchema,
  kUnsupportedMessageType,
  kSampleTooShort,
  kBadSourceId,
  kBadExpectedProbeCount,
  kBadGeometry,
  kBadNominalPeriod,
  kBadMappingGeneration,
  kBadReserved,
  kBadTemperatureEncoding,
  kBadChipTemperatureEncoding,
  kBadStatus,
};

struct DecodeResult {
  DecodeError error = DecodeError::kNullData;
  bool envelopeValid = false;
  Envelope envelope{};
  SampleV1 sample{};

  bool sampleValid() const { return error == DecodeError::kNone; }
};

struct EnvelopeResult {
  DecodeError error = DecodeError::kNullData;
  Envelope envelope{};

  bool valid() const { return error == DecodeError::kNone; }
};

uint32_t crc32IsoHdlc(const uint8_t* data, size_t length);
DecodeError validateSampleV1(const SampleV1& sample);
EnvelopeResult decodeEnvelope(const uint8_t* data, size_t length);
// Precondition: verifiedEnvelope is the successful decodeEnvelope() result for
// these exact bytes. Public callers normally use decodeDatagram(); the split
// form exists so ReceiverState can check the paired source before V1 parsing.
DecodeResult decodeSampleV1(const uint8_t* data,
                            size_t length,
                            const Envelope& verifiedEnvelope);
DecodeResult decodeDatagram(const uint8_t* data, size_t length);
DecodeError encodeSampleV1(const SampleV1& sample,
                          uint8_t* output,
                          size_t capacity,
                          size_t* written = nullptr);
const char* decodeErrorName(DecodeError error);

}  // namespace sauna_wire
