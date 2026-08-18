#include "probe_config.h"

#include <limits.h>
#include <stddef.h>
#include <string.h>

namespace sauna {
namespace {

constexpr uint32_t kProbeConfigMagic = 0x31464350;  // PCF1
constexpr uint16_t kProbeConfigVersion = 1;

bool recordsHaveSameGeneration(const ProbeMapping& left,
                               const ProbeMapping& right) {
  return left.generation == right.generation;
}

bool generationIsNewer(uint32_t candidate, uint32_t reference,
                       bool* ambiguous) {
  const uint32_t difference = candidate - reference;
  if (ambiguous) *ambiguous = difference == 0x80000000U;
  return difference != 0 && difference < 0x80000000U;
}

}  // namespace

uint32_t probeConfigCrc32(const uint8_t* data, size_t length,
                          uint32_t initial) {
  uint32_t crc = ~initial;
  for (size_t index = 0; index < length; ++index) {
    crc ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (0U - (crc & 1U)));
    }
  }
  return ~crc;
}

uint8_t probeRomCrc8(const uint8_t* data, size_t length) {
  uint8_t crc = 0;
  for (size_t index = 0; index < length; ++index) {
    uint8_t value = data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint8_t mix = (crc ^ value) & 0x01U;
      crc >>= 1;
      if (mix) crc ^= 0x8CU;
      value >>= 1;
    }
  }
  return crc;
}

bool probeRomIsValid(const uint8_t rom[kProbeRomBytes],
                     ProbeConfigError* error) {
  ProbeConfigError result = ProbeConfigError::None;
  if (!rom) {
    result = ProbeConfigError::BadRomCrc;
  } else if (rom[0] != 0x28U) {
    result = ProbeConfigError::BadRomFamily;
  } else if (probeRomCrc8(rom, kProbeRomBytes - 1) !=
             rom[kProbeRomBytes - 1]) {
    result = ProbeConfigError::BadRomCrc;
  }
  if (error) *error = result;
  return result == ProbeConfigError::None;
}

ProbeConfigError validateProbeMapping(const ProbeMapping& mapping) {
  if (mapping.geometryId != kProbeGeometryColumn8At20Cm)
    return ProbeConfigError::BadGeometry;
  for (size_t index = 0; index < kProbeCount; ++index) {
    ProbeConfigError error = ProbeConfigError::None;
    if (!probeRomIsValid(mapping.roms[index], &error)) return error;
    for (size_t previous = 0; previous < index; ++previous) {
      if (memcmp(mapping.roms[index], mapping.roms[previous],
                 kProbeRomBytes) == 0) {
        return ProbeConfigError::DuplicateRom;
      }
    }
  }
  return ProbeConfigError::None;
}

bool probeMappingsEqual(const ProbeMapping& left, const ProbeMapping& right) {
  return left.generation == right.generation &&
         left.geometryId == right.geometryId &&
         memcmp(left.roms, right.roms, sizeof(left.roms)) == 0;
}

int16_t probeRelativeHeightCm(uint16_t geometryId, size_t zeroBasedPosition) {
  if (geometryId != kProbeGeometryColumn8At20Cm ||
      zeroBasedPosition >= kProbeCount) {
    return INT16_MIN;
  }
  return static_cast<int16_t>(-20 * static_cast<int16_t>(zeroBasedPosition));
}

ProbeConfigRecordV1 makeProbeConfigRecord(const ProbeMapping& mapping,
                                          uint32_t generation) {
  ProbeConfigRecordV1 record{};
  record.magic = kProbeConfigMagic;
  record.version = kProbeConfigVersion;
  record.recordSize = sizeof(record);
  record.generation = generation;
  record.geometryId = mapping.geometryId;
  record.sensorCount = kProbeCount;
  memcpy(record.roms, mapping.roms, sizeof(record.roms));
  record.crc = probeConfigCrc32(
      reinterpret_cast<const uint8_t*>(&record),
      offsetof(ProbeConfigRecordV1, crc));
  return record;
}

ProbeConfigError decodeProbeConfigRecord(const void* data, size_t length,
                                         ProbeMapping* mapping,
                                         uint32_t* generation) {
  if (!data || length != sizeof(ProbeConfigRecordV1))
    return ProbeConfigError::BadRecordSize;
  ProbeConfigRecordV1 record{};
  memcpy(&record, data, sizeof(record));
  if (record.magic != kProbeConfigMagic) return ProbeConfigError::BadMagic;
  if (record.version != kProbeConfigVersion)
    return ProbeConfigError::BadVersion;
  if (record.recordSize != sizeof(record))
    return ProbeConfigError::BadRecordSize;
  if (!record.generation) return ProbeConfigError::BadGeneration;
  if (record.geometryId != kProbeGeometryColumn8At20Cm)
    return ProbeConfigError::BadGeometry;
  if (record.sensorCount != kProbeCount)
    return ProbeConfigError::BadSensorCount;
  if (record.reserved) return ProbeConfigError::BadReserved;
  if (record.crc !=
      probeConfigCrc32(reinterpret_cast<const uint8_t*>(&record),
                       offsetof(ProbeConfigRecordV1, crc))) {
    return ProbeConfigError::BadRecordCrc;
  }

  ProbeMapping decoded{};
  decoded.generation = record.generation;
  decoded.geometryId = record.geometryId;
  memcpy(decoded.roms, record.roms, sizeof(decoded.roms));
  const ProbeConfigError validation = validateProbeMapping(decoded);
  if (validation != ProbeConfigError::None) return validation;
  if (mapping) *mapping = decoded;
  if (generation) *generation = record.generation;
  return ProbeConfigError::None;
}

ProbeConfigSelection selectProbeConfigSlots(const ProbeConfigSlotData& slotA,
                                            const ProbeConfigSlotData& slotB) {
  ProbeConfigSelection selection{};
  selection.state = ProbeConfigState::Unconfigured;
  ProbeMapping mappingA{};
  ProbeMapping mappingB{};
  const bool presentA = slotA.length != 0;
  const bool presentB = slotB.length != 0;
  selection.slotAError =
      presentA ? decodeProbeConfigRecord(slotA.bytes, slotA.length, &mappingA)
               : ProbeConfigError::None;
  selection.slotBError =
      presentB ? decodeProbeConfigRecord(slotB.bytes, slotB.length, &mappingB)
               : ProbeConfigError::None;
  const bool validA = presentA && selection.slotAError == ProbeConfigError::None;
  const bool validB = presentB && selection.slotBError == ProbeConfigError::None;
  selection.validSlotCount = static_cast<uint8_t>(validA) +
                             static_cast<uint8_t>(validB);

  if (!validA && !validB) {
    selection.state = presentA || presentB ? ProbeConfigState::Corrupt
                                          : ProbeConfigState::Unconfigured;
    return selection;
  }
  selection.state = ProbeConfigState::Ready;
  if (validA && !validB) {
    selection.activeSlot = ProbeConfigSlot::A;
    selection.mapping = mappingA;
  } else if (!validA && validB) {
    selection.activeSlot = ProbeConfigSlot::B;
    selection.mapping = mappingB;
  } else if (recordsHaveSameGeneration(mappingA, mappingB)) {
    if (!probeMappingsEqual(mappingA, mappingB)) {
      selection.state = ProbeConfigState::Ambiguous;
      selection.activeSlot = ProbeConfigSlot::None;
      return selection;
    }
    selection.activeSlot = ProbeConfigSlot::A;
    selection.mapping = mappingA;
  } else {
    bool ambiguous = false;
    const bool aIsNewer = generationIsNewer(
        mappingA.generation, mappingB.generation, &ambiguous);
    if (ambiguous) {
      selection.state = ProbeConfigState::Ambiguous;
      selection.activeSlot = ProbeConfigSlot::None;
      return selection;
    }
    selection.activeSlot = aIsNewer ? ProbeConfigSlot::A : ProbeConfigSlot::B;
    selection.mapping = aIsNewer ? mappingA : mappingB;
  }
  selection.generation = selection.mapping.generation;
  return selection;
}

bool probeConfigIsUsable(const ProbeConfigSelection& selection) {
  return selection.state == ProbeConfigState::Ready &&
         selection.activeSlot != ProbeConfigSlot::None &&
         selection.mapping.generation != 0 &&
         validateProbeMapping(selection.mapping) == ProbeConfigError::None;
}

ProbeConfigSlot inactiveProbeConfigSlot(const ProbeConfigSelection& selection) {
  if (selection.state == ProbeConfigState::Ambiguous) return ProbeConfigSlot::None;
  return selection.activeSlot == ProbeConfigSlot::A ? ProbeConfigSlot::B
                                                     : ProbeConfigSlot::A;
}

uint32_t nextProbeConfigGeneration(const ProbeConfigSelection& selection) {
  uint32_t next = probeConfigIsUsable(selection)
                      ? selection.mapping.generation + 1U
                      : 1U;
  if (!next) next = 1;
  return next;
}

void beginProbeConfigStaging(ProbeConfigStaging* staging,
                             uint16_t geometryId) {
  if (!staging) return;
  memset(staging, 0, sizeof(*staging));
  staging->active = true;
  staging->geometryId = geometryId;
}

ProbeConfigError stageProbeConfigRom(
    ProbeConfigStaging* staging, uint8_t oneBasedPosition,
    const uint8_t rom[kProbeRomBytes]) {
  if (!staging || !staging->active) return ProbeConfigError::NotStaging;
  if (!oneBasedPosition || oneBasedPosition > kProbeCount)
    return ProbeConfigError::BadPosition;
  ProbeConfigError validation = ProbeConfigError::None;
  if (!probeRomIsValid(rom, &validation)) return validation;
  const size_t target = oneBasedPosition - 1;
  for (size_t index = 0; index < kProbeCount; ++index) {
    if (index != target && (staging->setMask & (1U << index)) &&
        memcmp(staging->roms[index], rom, kProbeRomBytes) == 0) {
      return ProbeConfigError::DuplicateRom;
    }
  }
  memcpy(staging->roms[target], rom, kProbeRomBytes);
  staging->setMask |= static_cast<uint8_t>(1U << target);
  return ProbeConfigError::None;
}

ProbeConfigError finishProbeConfigStaging(const ProbeConfigStaging& staging,
                                          ProbeMapping* mapping) {
  if (!staging.active) return ProbeConfigError::NotStaging;
  if (staging.setMask != 0xFFU) return ProbeConfigError::Incomplete;
  ProbeMapping candidate{};
  candidate.geometryId = staging.geometryId;
  memcpy(candidate.roms, staging.roms, sizeof(candidate.roms));
  const ProbeConfigError validation = validateProbeMapping(candidate);
  if (validation != ProbeConfigError::None) return validation;
  if (mapping) *mapping = candidate;
  return ProbeConfigError::None;
}

void abortProbeConfigStaging(ProbeConfigStaging* staging) {
  if (staging) memset(staging, 0, sizeof(*staging));
}

const char* probeConfigErrorName(ProbeConfigError error) {
  switch (error) {
    case ProbeConfigError::None:
      return "none";
    case ProbeConfigError::BadMagic:
      return "bad_magic";
    case ProbeConfigError::BadVersion:
      return "bad_version";
    case ProbeConfigError::BadRecordSize:
      return "bad_record_size";
    case ProbeConfigError::BadGeneration:
      return "bad_generation";
    case ProbeConfigError::BadGeometry:
      return "bad_geometry";
    case ProbeConfigError::BadSensorCount:
      return "bad_sensor_count";
    case ProbeConfigError::BadReserved:
      return "bad_reserved";
    case ProbeConfigError::BadRomFamily:
      return "bad_rom_family";
    case ProbeConfigError::BadRomCrc:
      return "bad_rom_crc";
    case ProbeConfigError::DuplicateRom:
      return "duplicate_rom";
    case ProbeConfigError::BadRecordCrc:
      return "bad_record_crc";
    case ProbeConfigError::NotStaging:
      return "not_staging";
    case ProbeConfigError::BadPosition:
      return "bad_position";
    case ProbeConfigError::Incomplete:
      return "incomplete";
  }
  return "unknown";
}

const char* probeConfigStateName(ProbeConfigState state) {
  switch (state) {
    case ProbeConfigState::Unconfigured:
      return "unconfigured";
    case ProbeConfigState::Ready:
      return "ready";
    case ProbeConfigState::Corrupt:
      return "corrupt";
    case ProbeConfigState::Ambiguous:
      return "ambiguous";
    case ProbeConfigState::StorageUnavailable:
      return "storage_unavailable";
  }
  return "unknown";
}

const char* probeConfigSlotName(ProbeConfigSlot slot) {
  switch (slot) {
    case ProbeConfigSlot::None:
      return "none";
    case ProbeConfigSlot::A:
      return "a";
    case ProbeConfigSlot::B:
      return "b";
  }
  return "unknown";
}

}  // namespace sauna
