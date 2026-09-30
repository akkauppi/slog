#include "saunan_wire.h"

#include <string.h>

namespace sauna_wire {
namespace {

constexpr uint8_t kMagic[4] = {'S', 'A', 'U', 'W'};

uint16_t readU16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) |
         static_cast<uint16_t>(static_cast<uint16_t>(data[1]) << 8U);
}

int16_t readI16(const uint8_t* data) {
  return static_cast<int16_t>(readU16(data));
}

uint32_t readU32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8U) |
         (static_cast<uint32_t>(data[2]) << 16U) |
         (static_cast<uint32_t>(data[3]) << 24U);
}

uint64_t readU64(const uint8_t* data) {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; ++index) {
    value |= static_cast<uint64_t>(data[index]) << (index * 8U);
  }
  return value;
}

void writeU16(uint8_t* data, uint16_t value) {
  data[0] = static_cast<uint8_t>(value);
  data[1] = static_cast<uint8_t>(value >> 8U);
}

void writeI16(uint8_t* data, int16_t value) {
  writeU16(data, static_cast<uint16_t>(value));
}

void writeU32(uint8_t* data, uint32_t value) {
  for (size_t index = 0; index < 4; ++index) {
    data[index] = static_cast<uint8_t>(value >> (index * 8U));
  }
}

void writeU64(uint8_t* data, uint64_t value) {
  for (size_t index = 0; index < 8; ++index) {
    data[index] = static_cast<uint8_t>(value >> (index * 8U));
  }
}

}  // namespace

uint8_t SampleV1::expectedMask() const {
  if (expectedProbeCount == 0 || expectedProbeCount > kChannelCapacity) {
    return 0;
  }
  return static_cast<uint8_t>((1U << expectedProbeCount) - 1U);
}

bool SampleV1::bootCounterValid() const {
  return (statusFlags & kBootCounterValid) != 0;
}

uint32_t crc32IsoHdlc(const uint8_t* data, size_t length) {
  uint32_t crc = 0xFFFFFFFFU;
  if (!data && length != 0) {
    return 0;
  }
  for (size_t index = 0; index < length; ++index) {
    crc ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1U) ^ (0xEDB88320U & (0U - (crc & 1U)));
    }
  }
  return crc ^ 0xFFFFFFFFU;
}

DecodeError validateSampleV1(const SampleV1& sample) {
  if (sample.sourceId == 0) {
    return DecodeError::kBadSourceId;
  }
  if (sample.expectedProbeCount == 0 ||
      sample.expectedProbeCount > kChannelCapacity) {
    return DecodeError::kBadExpectedProbeCount;
  }
  if (sample.geometryId == 0) {
    return DecodeError::kBadGeometry;
  }
  if (sample.nominalPeriodMs == 0) {
    return DecodeError::kBadNominalPeriod;
  }
  if (sample.mappingGeneration == 0) {
    return DecodeError::kBadMappingGeneration;
  }

  const uint8_t expectedMask = sample.expectedMask();
  if ((sample.validMask & static_cast<uint8_t>(~expectedMask)) != 0) {
    return DecodeError::kBadTemperatureEncoding;
  }
  for (size_t channel = 0; channel < kChannelCapacity; ++channel) {
    const bool valid = (sample.validMask & (1U << channel)) != 0;
    if (valid == (sample.centiC[channel] == kInvalidTemperature)) {
      return DecodeError::kBadTemperatureEncoding;
    }
  }

  const bool chipValid = (sample.statusFlags & kChipTemperatureValid) != 0;
  if (chipValid == (sample.chipCentiC == kInvalidTemperature)) {
    return DecodeError::kBadChipTemperatureEncoding;
  }
  const bool degraded = (sample.statusFlags & kSensorSetDegraded) != 0;
  if (degraded != (sample.validMask != expectedMask)) {
    return DecodeError::kBadStatus;
  }
  if ((sample.statusFlags & kMappingReady) == 0) {
    return DecodeError::kBadStatus;
  }
  if ((sample.statusFlags & kStandbyTest) && !sample.standby()) return DecodeError::kBadStatus;
  if (sample.standby() && (sample.statusFlags & (kSessionActive | kSyntheticSample)))
    return DecodeError::kBadStatus;
  const bool sessionActive = (sample.statusFlags & kSessionActive) != 0;
  if (sessionActive != (sample.recordingSessionId != 0)) {
    return DecodeError::kBadStatus;
  }
  return DecodeError::kNone;
}

EnvelopeResult decodeEnvelope(const uint8_t* data, size_t length) {
  EnvelopeResult result{};
  if (!data) {
    result.error = DecodeError::kNullData;
    return result;
  }
  if (length < kMinimumEnvelopeBytes) {
    result.error = DecodeError::kEnvelopeTooShort;
    return result;
  }
  if (length > kMaximumDatagramBytes) {
    result.error = DecodeError::kDatagramTooLong;
    return result;
  }
  if (memcmp(data, kMagic, sizeof(kMagic)) != 0) {
    result.error = DecodeError::kBadMagic;
    return result;
  }

  result.envelope.schemaMajor = data[4];
  result.envelope.messageType = data[5];
  result.envelope.totalBytes = readU16(data + 6);
  result.envelope.sourceId = readU64(data + 8);
  if (result.envelope.totalBytes != length) {
    result.error = DecodeError::kLengthMismatch;
    return result;
  }
  const uint32_t encodedCrc = readU32(data + length - sizeof(uint32_t));
  if (encodedCrc != crc32IsoHdlc(data, length - sizeof(uint32_t))) {
    result.error = DecodeError::kBadCrc;
    return result;
  }
  result.error = DecodeError::kNone;
  return result;
}

DecodeResult decodeSampleV1(const uint8_t* data,
                            size_t length,
                            const Envelope& verifiedEnvelope) {
  DecodeResult result{};
  result.envelope = verifiedEnvelope;
  result.envelopeValid = true;
  if (!data) {
    result.envelopeValid = false;
    result.error = DecodeError::kNullData;
    return result;
  }
  if (verifiedEnvelope.totalBytes != length ||
      length < kMinimumEnvelopeBytes || length > kMaximumDatagramBytes) {
    result.envelopeValid = false;
    result.error = DecodeError::kLengthMismatch;
    return result;
  }

  if (verifiedEnvelope.schemaMajor != kSchemaV1) {
    result.error = DecodeError::kUnsupportedSchema;
    return result;
  }
  if (verifiedEnvelope.messageType != kLiveSampleMessage) {
    result.error = DecodeError::kUnsupportedMessageType;
    return result;
  }
  if (length < kSampleV1Bytes) {
    result.error = DecodeError::kSampleTooShort;
    return result;
  }
  if (verifiedEnvelope.sourceId == 0) {
    result.error = DecodeError::kBadSourceId;
    return result;
  }
  if (readU16(data + 74) != 0) {
    result.error = DecodeError::kBadReserved;
    return result;
  }

  SampleV1& sample = result.sample;
  sample.sourceId = verifiedEnvelope.sourceId;
  sample.bootNonce = readU64(data + 16);
  sample.bootCounter = readU32(data + 24);
  sample.sequence = readU32(data + 28);
  sample.senderMonotonicMs = readU64(data + 32);
  sample.recordingSessionId = readU32(data + 40);
  sample.mappingGeneration = readU32(data + 44);
  sample.geometryId = readU16(data + 48);
  sample.nominalPeriodMs = readU16(data + 50);
  sample.statusFlags = readU16(data + 52);
  sample.validMask = data[54];
  sample.expectedProbeCount = data[55];
  for (size_t channel = 0; channel < kChannelCapacity; ++channel) {
    sample.centiC[channel] = readI16(data + 56 + channel * sizeof(int16_t));
  }
  sample.chipCentiC = readI16(data + 72);
  sample.skippedScheduleCount = readU32(data + 76);
  result.error = validateSampleV1(sample);
  return result;
}

DecodeResult decodeDatagram(const uint8_t* data, size_t length) {
  const EnvelopeResult envelope = decodeEnvelope(data, length);
  if (!envelope.valid()) {
    DecodeResult result{};
    result.error = envelope.error;
    result.envelope = envelope.envelope;
    return result;
  }
  return decodeSampleV1(data, length, envelope.envelope);
}

DecodeError encodeSampleV1(const SampleV1& sample,
                          uint8_t* output,
                          size_t capacity,
                          size_t* written) {
  if (written) {
    *written = 0;
  }
  if (!output) {
    return DecodeError::kNullData;
  }
  if (capacity < kSampleV1Bytes) {
    return DecodeError::kSampleTooShort;
  }
  // Unknown assigned bits are accepted by decoders for same-major forward
  // compatibility, but a V1 encoder must never originate them.
  if ((sample.statusFlags & static_cast<uint16_t>(~kKnownStatusFlags)) != 0) {
    return DecodeError::kBadStatus;
  }
  const DecodeError validation = validateSampleV1(sample);
  if (validation != DecodeError::kNone) {
    return validation;
  }

  memset(output, 0, kSampleV1Bytes);
  memcpy(output, kMagic, sizeof(kMagic));
  output[4] = kSchemaV1;
  output[5] = kLiveSampleMessage;
  writeU16(output + 6, static_cast<uint16_t>(kSampleV1Bytes));
  writeU64(output + 8, sample.sourceId);
  writeU64(output + 16, sample.bootNonce);
  writeU32(output + 24, sample.bootCounter);
  writeU32(output + 28, sample.sequence);
  writeU64(output + 32, sample.senderMonotonicMs);
  writeU32(output + 40, sample.recordingSessionId);
  writeU32(output + 44, sample.mappingGeneration);
  writeU16(output + 48, sample.geometryId);
  writeU16(output + 50, sample.nominalPeriodMs);
  writeU16(output + 52, sample.statusFlags);
  output[54] = sample.validMask;
  output[55] = sample.expectedProbeCount;
  for (size_t channel = 0; channel < kChannelCapacity; ++channel) {
    writeI16(output + 56 + channel * sizeof(int16_t), sample.centiC[channel]);
  }
  writeI16(output + 72, sample.chipCentiC);
  writeU16(output + 74, 0);
  writeU32(output + 76, sample.skippedScheduleCount);
  writeU32(output + 80, crc32IsoHdlc(output, 80));
  if (written) {
    *written = kSampleV1Bytes;
  }
  return DecodeError::kNone;
}

const char* decodeErrorName(DecodeError error) {
  switch (error) {
    case DecodeError::kNone:
      return "none";
    case DecodeError::kNullData:
      return "null_data";
    case DecodeError::kEnvelopeTooShort:
      return "envelope_too_short";
    case DecodeError::kDatagramTooLong:
      return "datagram_too_long";
    case DecodeError::kBadMagic:
      return "bad_magic";
    case DecodeError::kLengthMismatch:
      return "length_mismatch";
    case DecodeError::kBadCrc:
      return "bad_crc";
    case DecodeError::kUnsupportedSchema:
      return "unsupported_schema";
    case DecodeError::kUnsupportedMessageType:
      return "unsupported_message_type";
    case DecodeError::kSampleTooShort:
      return "sample_too_short";
    case DecodeError::kBadSourceId:
      return "bad_source_id";
    case DecodeError::kBadExpectedProbeCount:
      return "bad_expected_probe_count";
    case DecodeError::kBadGeometry:
      return "bad_geometry";
    case DecodeError::kBadNominalPeriod:
      return "bad_nominal_period";
    case DecodeError::kBadMappingGeneration:
      return "bad_mapping_generation";
    case DecodeError::kBadReserved:
      return "bad_reserved";
    case DecodeError::kBadTemperatureEncoding:
      return "bad_temperature_encoding";
    case DecodeError::kBadChipTemperatureEncoding:
      return "bad_chip_temperature_encoding";
    case DecodeError::kBadStatus:
      return "bad_status";
  }
  return "unknown";
}

}  // namespace sauna_wire
