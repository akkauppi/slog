#include "probe_config.h"

#include <cstring>
#include <iostream>
#include <string>

namespace {

using sauna::ProbeConfigError;
using sauna::ProbeConfigRecordV1;
using sauna::ProbeConfigSelection;
using sauna::ProbeConfigSlot;
using sauna::ProbeConfigSlotData;
using sauna::ProbeConfigStaging;
using sauna::ProbeConfigState;
using sauna::ProbeMapping;

bool check(bool condition, const std::string& message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

void fillRom(uint8_t rom[sauna::kProbeRomBytes], uint8_t identity) {
  std::memset(rom, 0, sauna::kProbeRomBytes);
  rom[0] = 0x28;
  rom[1] = identity;
  rom[2] = static_cast<uint8_t>(identity ^ 0x5A);
  rom[6] = static_cast<uint8_t>(identity + 17);
  rom[7] = sauna::probeRomCrc8(rom, sauna::kProbeRomBytes - 1);
}

ProbeMapping mapping(uint8_t seed, uint32_t generation) {
  ProbeMapping result{};
  result.generation = generation;
  result.geometryId = sauna::kProbeGeometryColumn8At20Cm;
  for (size_t index = 0; index < sauna::kProbeCount; ++index)
    fillRom(result.roms[index], static_cast<uint8_t>(seed + index));
  return result;
}

ProbeConfigSlotData slot(const ProbeConfigRecordV1& record) {
  ProbeConfigSlotData result{};
  result.length = sizeof(record);
  std::memcpy(result.bytes, &record, sizeof(record));
  return result;
}

void refreshRecordCrc(ProbeConfigRecordV1* record) {
  record->crc = sauna::probeConfigCrc32(
      reinterpret_cast<const uint8_t*>(record),
      offsetof(ProbeConfigRecordV1, crc));
}

bool crcAndRoundTrip() {
  static constexpr uint8_t text[] = {'1', '2', '3', '4', '5',
                                     '6', '7', '8', '9'};
  if (!check(sauna::probeConfigCrc32(text, sizeof(text)) == 0xCBF43926U,
             "CRC32 standard vector failed"))
    return false;

  const ProbeMapping expected = mapping(1, 42);
  const ProbeConfigRecordV1 record =
      sauna::makeProbeConfigRecord(expected, expected.generation);
  ProbeMapping decoded{};
  uint32_t generation = 0;
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record), &decoded,
                                             &generation) ==
                 ProbeConfigError::None,
             "valid record did not decode"))
    return false;
  return check(generation == 42 &&
                   sauna::probeMappingsEqual(expected, decoded),
               "record round trip changed mapping") &&
         check(sauna::probeRelativeHeightCm(
                   sauna::kProbeGeometryColumn8At20Cm, 0) == 0 &&
                   sauna::probeRelativeHeightCm(
                       sauna::kProbeGeometryColumn8At20Cm, 7) == -140,
               "reference geometry heights changed") &&
         check(sauna::probeRelativeHeightCm(99, 0) == INT16_MIN &&
                   sauna::probeRelativeHeightCm(
                       sauna::kProbeGeometryColumn8At20Cm, 8) == INT16_MIN,
               "invalid geometry position was accepted");
}

bool mappingAndRecordValidation() {
  ProbeMapping candidate = mapping(20, 0);
  if (!check(sauna::validateProbeMapping(candidate) == ProbeConfigError::None,
             "valid staged mapping rejected"))
    return false;
  candidate.geometryId = 99;
  if (!check(sauna::validateProbeMapping(candidate) ==
                 ProbeConfigError::BadGeometry,
             "unknown geometry accepted"))
    return false;
  candidate = mapping(20, 0);
  candidate.roms[3][0] = 0x10;
  if (!check(sauna::validateProbeMapping(candidate) ==
                 ProbeConfigError::BadRomFamily,
             "non-DS18B20 family accepted"))
    return false;
  candidate = mapping(20, 0);
  candidate.roms[3][7] ^= 1;
  if (!check(sauna::validateProbeMapping(candidate) ==
                 ProbeConfigError::BadRomCrc,
             "bad Dallas ROM CRC accepted"))
    return false;
  candidate = mapping(20, 0);
  std::memcpy(candidate.roms[7], candidate.roms[2], sauna::kProbeRomBytes);
  if (!check(sauna::validateProbeMapping(candidate) ==
                 ProbeConfigError::DuplicateRom,
             "duplicate ROM accepted"))
    return false;

  ProbeConfigRecordV1 record =
      sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record) - 1) ==
                 ProbeConfigError::BadRecordSize,
             "truncated record accepted"))
    return false;
  ++record.magic;
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadMagic,
             "bad magic accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  record.version = 2;
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadVersion,
             "unknown version accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 0);
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadGeneration,
             "zero generation accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  record.sensorCount = 7;
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadSensorCount,
             "wrong sensor count accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  record.reserved = 1;
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadReserved,
             "nonzero reserved byte accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  record.roms[0][0] = 0x10;
  refreshRecordCrc(&record);
  if (!check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                 ProbeConfigError::BadRomFamily,
             "record with invalid ROM accepted"))
    return false;
  record = sauna::makeProbeConfigRecord(mapping(20, 4), 4);
  record.crc ^= 1;
  return check(sauna::decodeProbeConfigRecord(&record, sizeof(record)) ==
                   ProbeConfigError::BadRecordCrc,
               "bad record CRC accepted");
}

bool stagingRules() {
  ProbeConfigStaging staging{};
  uint8_t rom[sauna::kProbeRomBytes]{};
  fillRom(rom, 1);
  if (!check(sauna::stageProbeConfigRom(&staging, 1, rom) ==
                 ProbeConfigError::NotStaging,
             "SET outside staging accepted"))
    return false;
  sauna::beginProbeConfigStaging(&staging,
                                 sauna::kProbeGeometryColumn8At20Cm);
  if (!check(sauna::stageProbeConfigRom(&staging, 0, rom) ==
                 ProbeConfigError::BadPosition,
             "position zero accepted"))
    return false;
  if (!check(sauna::stageProbeConfigRom(&staging, 9, rom) ==
                 ProbeConfigError::BadPosition,
             "position nine accepted"))
    return false;
  if (!check(sauna::stageProbeConfigRom(&staging, 1, rom) ==
                 ProbeConfigError::None,
             "valid staged ROM rejected"))
    return false;
  if (!check(sauna::stageProbeConfigRom(&staging, 2, rom) ==
                 ProbeConfigError::DuplicateRom,
             "duplicate staged ROM accepted"))
    return false;
  ProbeMapping finished{};
  if (!check(sauna::finishProbeConfigStaging(staging, &finished) ==
                 ProbeConfigError::Incomplete,
             "partial staging committed"))
    return false;
  for (uint8_t position = 2; position <= sauna::kProbeCount; ++position) {
    fillRom(rom, position);
    if (!check(sauna::stageProbeConfigRom(&staging, position, rom) ==
                   ProbeConfigError::None,
               "valid position failed to stage"))
      return false;
  }
  if (!check(sauna::finishProbeConfigStaging(staging, &finished) ==
                 ProbeConfigError::None &&
                 finished.generation == 0,
             "complete staging did not finish"))
    return false;
  sauna::abortProbeConfigStaging(&staging);
  return check(!staging.active && staging.setMask == 0,
               "abort did not clear staging");
}

bool selectionRules() {
  const ProbeConfigSlotData empty{};
  const ProbeMapping oldMapping = mapping(1, 10);
  const ProbeMapping newMapping = mapping(30, 11);
  const ProbeConfigSlotData oldSlot =
      slot(sauna::makeProbeConfigRecord(oldMapping, oldMapping.generation));
  const ProbeConfigSlotData newSlot =
      slot(sauna::makeProbeConfigRecord(newMapping, newMapping.generation));

  ProbeConfigSelection selected = sauna::selectProbeConfigSlots(empty, empty);
  if (!check(selected.state == ProbeConfigState::Unconfigured,
             "empty slots were not unconfigured"))
    return false;
  selected = sauna::selectProbeConfigSlots(oldSlot, empty);
  if (!check(sauna::probeConfigIsUsable(selected) &&
                 selected.activeSlot == ProbeConfigSlot::A &&
                 selected.validSlotCount == 1,
             "sole valid A slot not selected"))
    return false;
  selected = sauna::selectProbeConfigSlots(oldSlot, newSlot);
  if (!check(selected.activeSlot == ProbeConfigSlot::B &&
                 selected.generation == 11 &&
                 selected.validSlotCount == 2,
             "newer B generation not selected"))
    return false;

  ProbeConfigSlotData badNew = newSlot;
  badNew.bytes[20] ^= 1;
  selected = sauna::selectProbeConfigSlots(oldSlot, badNew);
  if (!check(selected.activeSlot == ProbeConfigSlot::A &&
                 selected.generation == 10 &&
                 selected.validSlotCount == 1,
             "bad newer slot did not fall back to old slot"))
    return false;

  const ProbeMapping maximum = mapping(1, UINT32_MAX);
  const ProbeMapping wrapped = mapping(30, 1);
  selected = sauna::selectProbeConfigSlots(
      slot(sauna::makeProbeConfigRecord(maximum, maximum.generation)),
      slot(sauna::makeProbeConfigRecord(wrapped, wrapped.generation)));
  if (!check(selected.activeSlot == ProbeConfigSlot::B &&
                 sauna::nextProbeConfigGeneration(selected) == 2,
             "generation wrap was not ordered"))
    return false;

  const ProbeMapping halfway = mapping(30, 0x8000000AU);
  selected = sauna::selectProbeConfigSlots(
      oldSlot,
      slot(sauna::makeProbeConfigRecord(halfway, halfway.generation)));
  if (!check(selected.state == ProbeConfigState::Ambiguous,
             "half-range generations were ordered"))
    return false;

  selected = sauna::selectProbeConfigSlots(oldSlot, oldSlot);
  if (!check(selected.state == ProbeConfigState::Ready &&
                 selected.activeSlot == ProbeConfigSlot::A,
             "identical equal-generation slots were ambiguous"))
    return false;
  ProbeMapping conflict = mapping(30, 10);
  selected = sauna::selectProbeConfigSlots(
      oldSlot, slot(sauna::makeProbeConfigRecord(conflict, 10)));
  if (!check(selected.state == ProbeConfigState::Ambiguous,
             "different equal-generation records were accepted"))
    return false;

  ProbeConfigSlotData malformed{};
  malformed.length = 3;
  selected = sauna::selectProbeConfigSlots(malformed, empty);
  return check(selected.state == ProbeConfigState::Corrupt,
               "present malformed slot was called unconfigured");
}

bool everyTornWritePreservesOldSlot() {
  const ProbeMapping oldMapping = mapping(1, 71);
  const ProbeMapping newMapping = mapping(30, 72);
  const ProbeConfigSlotData oldSlot =
      slot(sauna::makeProbeConfigRecord(oldMapping, oldMapping.generation));
  const ProbeConfigRecordV1 newRecord =
      sauna::makeProbeConfigRecord(newMapping, newMapping.generation);
  const auto* raw = reinterpret_cast<const uint8_t*>(&newRecord);
  for (size_t prefix = 0; prefix < sizeof(newRecord); ++prefix) {
    ProbeConfigSlotData torn{};
    torn.length = prefix;
    if (prefix) std::memcpy(torn.bytes, raw, prefix);
    const ProbeConfigSelection selected =
        sauna::selectProbeConfigSlots(oldSlot, torn);
    if (!check(sauna::probeConfigIsUsable(selected) &&
                   selected.activeSlot == ProbeConfigSlot::A &&
                   selected.generation == oldMapping.generation,
               "torn inactive-slot write displaced old mapping at prefix " +
                   std::to_string(prefix)))
      return false;
  }
  const ProbeConfigSelection complete =
      sauna::selectProbeConfigSlots(oldSlot, slot(newRecord));
  return check(complete.activeSlot == ProbeConfigSlot::B &&
                   complete.generation == newMapping.generation,
               "complete inactive-slot write was not activated");
}

}  // namespace

int main() {
  if (!crcAndRoundTrip()) return 1;
  if (!mappingAndRecordValidation()) return 1;
  if (!stagingRules()) return 1;
  if (!selectionRules()) return 1;
  if (!everyTornWritePreservesOldSlot()) return 1;
  return 0;
}
