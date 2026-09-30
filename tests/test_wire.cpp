#include <assert.h>
#include <stdint.h>
#include <string.h>

#include <algorithm>
#include <array>
#include <iostream>
#include <vector>

#include "saunan_wire.h"

using sauna_wire::DecodeError;
using sauna_wire::DecodeResult;
using sauna_wire::SampleV1;

namespace {

void writeU16(uint8_t* output, uint16_t value) {
  output[0] = static_cast<uint8_t>(value);
  output[1] = static_cast<uint8_t>(value >> 8U);
}

void writeU32(uint8_t* output, uint32_t value) {
  for (size_t index = 0; index < 4; ++index) {
    output[index] = static_cast<uint8_t>(value >> (index * 8U));
  }
}

void seal(std::vector<uint8_t>& bytes) {
  writeU16(bytes.data() + 6, static_cast<uint16_t>(bytes.size()));
  writeU32(bytes.data() + bytes.size() - 4,
           sauna_wire::crc32IsoHdlc(bytes.data(), bytes.size() - 4));
}

SampleV1 sampleForCount(uint8_t count, uint8_t validMask) {
  SampleV1 sample{};
  sample.sourceId = UINT64_C(0x1122334455667788);
  sample.bootNonce = UINT64_C(0x8877665544332211);
  sample.bootCounter = 0xA1B2C3D4U;
  sample.sequence = 0x10203040U;
  sample.senderMonotonicMs = UINT64_C(0x0102030405060708);
  sample.recordingSessionId = 0;
  sample.mappingGeneration = 0x55667788U;
  sample.geometryId = sauna_wire::kGeometryColumn8At20Cm;
  sample.nominalPeriodMs = 10000;
  sample.statusFlags = sauna_wire::kBootCounterValid |
                       sauna_wire::kMappingReady |
                       sauna_wire::kStorageReady |
                       sauna_wire::kChipTemperatureValid;
  sample.validMask = validMask;
  sample.expectedProbeCount = count;
  for (size_t channel = 0; channel < sauna_wire::kChannelCapacity; ++channel) {
    if ((validMask & (1U << channel)) != 0) {
      sample.centiC[channel] = static_cast<int16_t>(-1234 + channel * 2345);
    } else {
      sample.centiC[channel] = sauna_wire::kInvalidTemperature;
    }
  }
  sample.chipCentiC = 3141;
  sample.skippedScheduleCount = 0x90ABCDEFU;
  if (validMask != sample.expectedMask()) {
    sample.statusFlags |= sauna_wire::kSensorSetDegraded;
  }
  return sample;
}

std::vector<uint8_t> encode(const SampleV1& sample) {
  std::vector<uint8_t> bytes(sauna_wire::kSampleV1Bytes);
  size_t written = 0;
  assert(sauna_wire::encodeSampleV1(sample, bytes.data(), bytes.size(),
                                    &written) == DecodeError::kNone);
  assert(written == bytes.size());
  return bytes;
}

// Literal records are intentionally independent of the production encoder.
// They lock every V1 offset, little-endian field, sentinel, and CRC byte.
constexpr std::array<uint8_t, sauna_wire::kSampleV1Bytes> kGoldenN1 = {
    0x53, 0x41, 0x55, 0x57, 0x01, 0x01, 0x54, 0x00,
    0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0xD4, 0xC3, 0xB2, 0xA1, 0x40, 0x30, 0x20, 0x10,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x88, 0x77, 0x66, 0x55,
    0x01, 0x00, 0x10, 0x27, 0x71, 0x00, 0x01, 0x01,
    0x2E, 0xFB, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80,
    0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80,
    0x45, 0x0C, 0x00, 0x00, 0xEF, 0xCD, 0xAB, 0x90,
    0x77, 0x7E, 0x2C, 0x42,
};

constexpr std::array<uint8_t, sauna_wire::kSampleV1Bytes> kGoldenN5 = {
    0x53, 0x41, 0x55, 0x57, 0x01, 0x01, 0x54, 0x00,
    0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0xD4, 0xC3, 0xB2, 0xA1, 0x40, 0x30, 0x20, 0x10,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x88, 0x77, 0x66, 0x55,
    0x01, 0x00, 0x10, 0x27, 0x71, 0x00, 0x1F, 0x05,
    0x2E, 0xFB, 0x57, 0x04, 0x80, 0x0D, 0xA9, 0x16,
    0xD2, 0x1F, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80,
    0x45, 0x0C, 0x00, 0x00, 0xEF, 0xCD, 0xAB, 0x90,
    0x3F, 0x56, 0x7B, 0xD5,
};

constexpr std::array<uint8_t, sauna_wire::kSampleV1Bytes> kGoldenN8 = {
    0x53, 0x41, 0x55, 0x57, 0x01, 0x01, 0x54, 0x00,
    0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0xD4, 0xC3, 0xB2, 0xA1, 0x40, 0x30, 0x20, 0x10,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x88, 0x77, 0x66, 0x55,
    0x01, 0x00, 0x10, 0x27, 0x71, 0x00, 0xFF, 0x08,
    0x2E, 0xFB, 0x57, 0x04, 0x80, 0x0D, 0xA9, 0x16,
    0xD2, 0x1F, 0xFB, 0x28, 0x24, 0x32, 0x4D, 0x3B,
    0x45, 0x0C, 0x00, 0x00, 0xEF, 0xCD, 0xAB, 0x90,
    0xB8, 0x2F, 0x1A, 0x6C,
};

constexpr std::array<uint8_t, 90> kGoldenN8WithTail = {
    0x53, 0x41, 0x55, 0x57, 0x01, 0x01, 0x5A, 0x00,
    0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0xD4, 0xC3, 0xB2, 0xA1, 0x40, 0x30, 0x20, 0x10,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x88, 0x77, 0x66, 0x55,
    0x01, 0x00, 0x10, 0x27, 0x71, 0x00, 0xFF, 0x08,
    0x2E, 0xFB, 0x57, 0x04, 0x80, 0x0D, 0xA9, 0x16,
    0xD2, 0x1F, 0xFB, 0x28, 0x24, 0x32, 0x4D, 0x3B,
    0x45, 0x0C, 0x00, 0x00, 0xEF, 0xCD, 0xAB, 0x90,
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5,
    0xF2, 0x26, 0x9E, 0xD7,
};

void expectDecodeError(std::vector<uint8_t> bytes, DecodeError error) {
  seal(bytes);
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error == error);
}

void testKnownCrc() {
  static constexpr uint8_t kCheck[] = {'1', '2', '3', '4', '5',
                                        '6', '7', '8', '9'};
  assert(sauna_wire::crc32IsoHdlc(kCheck, sizeof(kCheck)) == 0xCBF43926U);
  assert(sauna_wire::crc32IsoHdlc(nullptr, 0) == 0U);
}

void testLiteralGoldenVectors() {
  struct Fixture {
    uint8_t count;
    const std::array<uint8_t, sauna_wire::kSampleV1Bytes>* bytes;
  };
  const Fixture fixtures[] = {
      {1, &kGoldenN1},
      {5, &kGoldenN5},
      {8, &kGoldenN8},
  };
  for (const Fixture& fixture : fixtures) {
    const std::vector<uint8_t> encoded =
        encode(sampleForCount(fixture.count,
                              static_cast<uint8_t>((1U << fixture.count) - 1U)));
    assert(std::equal(encoded.begin(), encoded.end(), fixture.bytes->begin()));
    const DecodeResult decoded = sauna_wire::decodeDatagram(
        fixture.bytes->data(), fixture.bytes->size());
    assert(decoded.sampleValid());
    assert(decoded.sample.expectedProbeCount == fixture.count);
    assert(decoded.sample.validMask ==
           static_cast<uint8_t>((1U << fixture.count) - 1U));
  }

  const DecodeResult tailed = sauna_wire::decodeDatagram(
      kGoldenN8WithTail.data(), kGoldenN8WithTail.size());
  assert(tailed.sampleValid());
  assert(tailed.envelope.totalBytes == kGoldenN8WithTail.size());
  assert(tailed.sample.expectedProbeCount == 8);
}

void testRoundTripAndEndianLayout() {
  const SampleV1 original = sampleForCount(5, 0x1FU);
  const std::vector<uint8_t> bytes = encode(original);

  assert(bytes[0] == 'S' && bytes[1] == 'A' && bytes[2] == 'U' &&
         bytes[3] == 'W');
  assert(bytes[4] == 1 && bytes[5] == 1);
  assert(bytes[6] == 84 && bytes[7] == 0);
  assert(bytes[8] == 0x88 && bytes[15] == 0x11);
  assert(bytes[55] == 5);
  assert(bytes[76] == 0xEF && bytes[79] == 0x90);

  const DecodeResult decoded =
      sauna_wire::decodeDatagram(bytes.data(), bytes.size());
  assert(decoded.sampleValid());
  assert(decoded.envelopeValid);
  assert(decoded.sample.sourceId == original.sourceId);
  assert(decoded.sample.bootNonce == original.bootNonce);
  assert(decoded.sample.bootCounter == original.bootCounter);
  assert(decoded.sample.sequence == original.sequence);
  assert(decoded.sample.senderMonotonicMs == original.senderMonotonicMs);
  assert(decoded.sample.mappingGeneration == original.mappingGeneration);
  assert(decoded.sample.expectedProbeCount == 5);
  assert(decoded.sample.expectedMask() == 0x1FU);
  assert(decoded.sample.centiC == original.centiC);
  assert(decoded.sample.chipCentiC == original.chipCentiC);
  assert(decoded.sample.skippedScheduleCount == original.skippedScheduleCount);
}

void testAllExpectedCountsAndValidSubmasks() {
  for (uint8_t count = 1; count <= 8; ++count) {
    const uint16_t limit = static_cast<uint16_t>(1U << count);
    for (uint16_t mask = 0; mask < limit; ++mask) {
      SampleV1 sample = sampleForCount(count, static_cast<uint8_t>(mask));
      const std::vector<uint8_t> bytes = encode(sample);
      const DecodeResult decoded =
          sauna_wire::decodeDatagram(bytes.data(), bytes.size());
      assert(decoded.sampleValid());
    }
  }

  SampleV1 sample = sampleForCount(3, 0x07U);
  std::vector<uint8_t> withFutureStatusBit = encode(sample);
  withFutureStatusBit[53] |= 0x80U;
  seal(withFutureStatusBit);
  const DecodeResult decoded = sauna_wire::decodeDatagram(
      withFutureStatusBit.data(), withFutureStatusBit.size());
  assert(decoded.sampleValid());
  assert((decoded.sample.statusFlags & 0x8000U) != 0);

  sample.statusFlags |= 0x8000U;
  std::array<uint8_t, sauna_wire::kSampleV1Bytes> output{};
  assert(sauna_wire::encodeSampleV1(sample, output.data(), output.size()) ==
         DecodeError::kBadStatus);
}

void testEnvelopeAndExtensions() {
  const std::vector<uint8_t> base = encode(sampleForCount(8, 0xFFU));

  std::vector<uint8_t> unaligned(base.size() + 1U);
  memcpy(unaligned.data() + 1, base.data(), base.size());
  assert(sauna_wire::decodeDatagram(unaligned.data() + 1, base.size())
             .sampleValid());

  for (size_t length = 0; length < base.size(); ++length) {
    assert(!sauna_wire::decodeDatagram(base.data(), length).sampleValid());
  }

  std::vector<uint8_t> extended(90, 0);
  memcpy(extended.data(), base.data(), 80);
  for (size_t index = 80; index < 86; ++index) {
    extended[index] = static_cast<uint8_t>(0xA0U + index - 80U);
  }
  seal(extended);
  assert(sauna_wire::decodeDatagram(extended.data(), extended.size())
             .sampleValid());
  extended[83] ^= 0x40U;
  assert(sauna_wire::decodeDatagram(extended.data(), extended.size()).error ==
         DecodeError::kBadCrc);

  std::vector<uint8_t> unknownSchema = base;
  unknownSchema[4] = 2;
  seal(unknownSchema);
  const sauna_wire::EnvelopeResult envelope =
      sauna_wire::decodeEnvelope(unknownSchema.data(), unknownSchema.size());
  assert(envelope.valid());
  assert(envelope.envelope.sourceId == sampleForCount(8, 0xFFU).sourceId);
  const DecodeResult unsupported =
      sauna_wire::decodeDatagram(unknownSchema.data(), unknownSchema.size());
  assert(unsupported.envelopeValid);
  assert(unsupported.error == DecodeError::kUnsupportedSchema);

  std::vector<uint8_t> maximum(250, 0);
  memcpy(maximum.data(), base.data(), 80);
  seal(maximum);
  assert(sauna_wire::decodeDatagram(maximum.data(), maximum.size())
             .sampleValid());

  std::vector<uint8_t> tooLong(251, 0);
  memcpy(tooLong.data(), base.data(), 80);
  seal(tooLong);
  assert(sauna_wire::decodeEnvelope(tooLong.data(), tooLong.size()).error ==
         DecodeError::kDatagramTooLong);

  // Merely appending a tail leaves the old CRC in the payload and no valid
  // relocated trailing CRC.
  std::vector<uint8_t> misplacedCrc = base;
  misplacedCrc.resize(90, 0);
  writeU16(misplacedCrc.data() + 6,
           static_cast<uint16_t>(misplacedCrc.size()));
  assert(sauna_wire::decodeEnvelope(misplacedCrc.data(), misplacedCrc.size())
             .error == DecodeError::kBadCrc);
}

void testMinimalStableEnvelopes() {
  std::vector<uint8_t> bytes(sauna_wire::kMinimumEnvelopeBytes, 0);
  bytes[0] = 'S';
  bytes[1] = 'A';
  bytes[2] = 'U';
  bytes[3] = 'W';
  bytes[4] = 2;
  bytes[5] = 1;
  for (size_t index = 0; index < 8; ++index) {
    bytes[8 + index] = static_cast<uint8_t>(0x10U + index);
  }
  seal(bytes);
  assert(sauna_wire::decodeEnvelope(bytes.data(), bytes.size()).valid());
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kUnsupportedSchema);

  bytes[4] = sauna_wire::kSchemaV1;
  bytes[5] = 9;
  seal(bytes);
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kUnsupportedMessageType);

  bytes[5] = sauna_wire::kLiveSampleMessage;
  seal(bytes);
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kSampleTooShort);
}

void testMalformedPayloads() {
  const std::vector<uint8_t> good = encode(sampleForCount(5, 0x1FU));

  std::vector<uint8_t> bytes = good;
  bytes[0] = 'X';
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kBadMagic);

  bytes = good;
  bytes[6] = 83;
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kLengthMismatch);

  bytes = good;
  bytes[20] ^= 1U;
  assert(sauna_wire::decodeDatagram(bytes.data(), bytes.size()).error ==
         DecodeError::kBadCrc);

  bytes = good;
  bytes[5] = 9;
  expectDecodeError(bytes, DecodeError::kUnsupportedMessageType);

  bytes = good;
  bytes[55] = 0;
  expectDecodeError(bytes, DecodeError::kBadExpectedProbeCount);
  bytes = good;
  bytes[55] = 9;
  expectDecodeError(bytes, DecodeError::kBadExpectedProbeCount);

  bytes = good;
  bytes[74] = 1;
  expectDecodeError(bytes, DecodeError::kBadReserved);

  bytes = good;
  bytes[54] = 0x3FU;
  expectDecodeError(bytes, DecodeError::kBadTemperatureEncoding);

  bytes = good;
  writeU16(bytes.data() + 56, 0x8000U);
  expectDecodeError(bytes, DecodeError::kBadTemperatureEncoding);

  bytes = good;
  writeU16(bytes.data() + 56 + 5 * 2, 1234);
  expectDecodeError(bytes, DecodeError::kBadTemperatureEncoding);

  bytes = good;
  bytes[52] ^= static_cast<uint8_t>(sauna_wire::kSensorSetDegraded);
  expectDecodeError(bytes, DecodeError::kBadStatus);

  bytes = good;
  bytes[52] &= static_cast<uint8_t>(~sauna_wire::kMappingReady);
  expectDecodeError(bytes, DecodeError::kBadStatus);

  bytes = good;
  writeU32(bytes.data() + 44, 0);
  expectDecodeError(bytes, DecodeError::kBadMappingGeneration);

  bytes = good;
  bytes[52] |= static_cast<uint8_t>(sauna_wire::kSessionActive);
  expectDecodeError(bytes, DecodeError::kBadStatus);

  bytes = good;
  bytes[52] &= static_cast<uint8_t>(~sauna_wire::kChipTemperatureValid);
  expectDecodeError(bytes, DecodeError::kBadChipTemperatureEncoding);
}

void testEncoderRejectsInvalidModels() {
  std::array<uint8_t, sauna_wire::kSampleV1Bytes> bytes{};
  SampleV1 sample = sampleForCount(1, 0x01U);
  sample.sourceId = 0;
  assert(sauna_wire::encodeSampleV1(sample, bytes.data(), bytes.size()) ==
         DecodeError::kBadSourceId);
  sample = sampleForCount(1, 0x01U);
  sample.geometryId = 0;
  assert(sauna_wire::encodeSampleV1(sample, bytes.data(), bytes.size()) ==
         DecodeError::kBadGeometry);
  sample = sampleForCount(1, 0x01U);
  sample.nominalPeriodMs = 0;
  assert(sauna_wire::encodeSampleV1(sample, bytes.data(), bytes.size()) ==
         DecodeError::kBadNominalPeriod);

  sample = sampleForCount(1, 0x01U);
  size_t written = 123;
  assert(sauna_wire::encodeSampleV1(sample, nullptr, bytes.size(), &written) ==
         DecodeError::kNullData);
  assert(written == 0);
  written = 123;
  assert(sauna_wire::encodeSampleV1(sample, bytes.data(), bytes.size() - 1U,
                                    &written) ==
         DecodeError::kSampleTooShort);
  assert(written == 0);
}

void testTemperatureAndSessionEdges() {
  SampleV1 sample = sampleForCount(2, 0x03U);
  sample.centiC[0] = INT16_MIN + 1;
  sample.centiC[1] = INT16_MAX;
  sample.recordingSessionId = 123;
  sample.statusFlags |= sauna_wire::kSessionActive;
  assert(sauna_wire::decodeDatagram(encode(sample).data(),
                                    sauna_wire::kSampleV1Bytes)
             .sampleValid());

  std::vector<uint8_t> bytes = encode(sampleForCount(2, 0x03U));
  bytes[52] |= static_cast<uint8_t>(sauna_wire::kChipTemperatureValid);
  writeU16(bytes.data() + 72, 0x8000U);
  expectDecodeError(bytes, DecodeError::kBadChipTemperatureEncoding);

  bytes = encode(sampleForCount(2, 0x03U));
  bytes[52] &= static_cast<uint8_t>(~sauna_wire::kChipTemperatureValid);
  writeU16(bytes.data() + 72, 1234);
  expectDecodeError(bytes, DecodeError::kBadChipTemperatureEncoding);

  bytes = encode(sampleForCount(2, 0x03U));
  writeU32(bytes.data() + 40, 123);
  expectDecodeError(bytes, DecodeError::kBadStatus);
}

}  // namespace

int main() {
  {
    auto sample = sampleForCount(8, 0xff);
    sample.statusFlags |= sauna_wire::kColdStandby;
    auto bytes = encode(sample);
    auto decoded = sauna_wire::decodeDatagram(bytes.data(), bytes.size());
    assert(decoded.sampleValid() && decoded.sample.samplePeriodMs()==150000);
    assert(decoded.sample.transmitPeriodMs()==900000);
    sample.statusFlags |= sauna_wire::kStandbyTest;
    bytes=encode(sample); decoded=sauna_wire::decodeDatagram(bytes.data(),bytes.size());
    assert(decoded.sampleValid() && decoded.sample.transmitPeriodMs()==300000);
    sample.statusFlags |= sauna_wire::kSessionActive; sample.recordingSessionId=1;
    assert(sauna_wire::validateSampleV1(sample)==DecodeError::kBadStatus);
    sample.statusFlags &= ~sauna_wire::kSessionActive; sample.recordingSessionId=0;
    sample.statusFlags &= ~sauna_wire::kColdStandby;
    assert(sauna_wire::validateSampleV1(sample)==DecodeError::kBadStatus);
  }

  {
    auto sample = sampleForCount(8, 0xff);
    sample.statusFlags |= sauna_wire::kSyntheticSample;
    const auto bytes = encode(sample);
    const auto decoded = sauna_wire::decodeDatagram(bytes.data(), bytes.size());
    assert(decoded.sampleValid());
    assert(decoded.sample.statusFlags & sauna_wire::kSyntheticSample);
  }
  testKnownCrc();
  testLiteralGoldenVectors();
  testRoundTripAndEndianLayout();
  testAllExpectedCountsAndValidSubmasks();
  testEnvelopeAndExtensions();
  testMinimalStableEnvelopes();
  testMalformedPayloads();
  testEncoderRejectsInvalidModels();
  testTemperatureAndSessionEdges();
  std::cout << "wire codec tests passed\n";
  return 0;
}
