#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sauna {

constexpr size_t kProbeCount = 8;
constexpr size_t kProbeRomBytes = 8;
constexpr uint16_t kProbeGeometryColumn8At20Cm = 1;

struct ProbeMapping {
  uint32_t generation;
  uint16_t geometryId;
  uint8_t roms[kProbeCount][kProbeRomBytes];
};

enum class ProbeConfigError : uint8_t {
  None = 0,
  BadMagic,
  BadVersion,
  BadRecordSize,
  BadGeneration,
  BadGeometry,
  BadSensorCount,
  BadReserved,
  BadRomFamily,
  BadRomCrc,
  DuplicateRom,
  BadRecordCrc,
  NotStaging,
  BadPosition,
  Incomplete,
};

struct __attribute__((packed)) ProbeConfigRecordV1 {
  uint32_t magic;
  uint16_t version;
  uint16_t recordSize;
  uint32_t generation;
  uint16_t geometryId;
  uint8_t sensorCount;
  uint8_t reserved;
  uint8_t roms[kProbeCount][kProbeRomBytes];
  uint32_t crc;
};

static_assert(sizeof(ProbeConfigRecordV1) == 84,
              "probe configuration record layout changed");

struct ProbeConfigSlotData {
  size_t length;
  uint8_t bytes[sizeof(ProbeConfigRecordV1)];
};

enum class ProbeConfigState : uint8_t {
  Unconfigured = 0,
  Ready,
  Corrupt,
  Ambiguous,
  StorageUnavailable,
};

enum class ProbeConfigSlot : uint8_t {
  None = 0,
  A,
  B,
};

struct ProbeConfigSelection {
  ProbeConfigState state;
  ProbeConfigSlot activeSlot;
  uint8_t validSlotCount;
  uint32_t generation;
  ProbeMapping mapping;
  ProbeConfigError slotAError;
  ProbeConfigError slotBError;
};

struct ProbeConfigStaging {
  bool active;
  uint16_t geometryId;
  uint8_t setMask;
  uint8_t roms[kProbeCount][kProbeRomBytes];
};

uint32_t probeConfigCrc32(const uint8_t* data, size_t length,
                          uint32_t initial = 0);
uint8_t probeRomCrc8(const uint8_t* data, size_t length);
bool probeRomIsValid(const uint8_t rom[kProbeRomBytes],
                     ProbeConfigError* error = nullptr);
ProbeConfigError validateProbeMapping(const ProbeMapping& mapping);
bool probeMappingsEqual(const ProbeMapping& left, const ProbeMapping& right);
int16_t probeRelativeHeightCm(uint16_t geometryId, size_t zeroBasedPosition);

ProbeConfigRecordV1 makeProbeConfigRecord(const ProbeMapping& mapping,
                                          uint32_t generation);
ProbeConfigError decodeProbeConfigRecord(const void* data, size_t length,
                                         ProbeMapping* mapping = nullptr,
                                         uint32_t* generation = nullptr);
ProbeConfigSelection selectProbeConfigSlots(const ProbeConfigSlotData& slotA,
                                            const ProbeConfigSlotData& slotB);
bool probeConfigIsUsable(const ProbeConfigSelection& selection);
ProbeConfigSlot inactiveProbeConfigSlot(const ProbeConfigSelection& selection);
uint32_t nextProbeConfigGeneration(const ProbeConfigSelection& selection);

void beginProbeConfigStaging(ProbeConfigStaging* staging, uint16_t geometryId);
ProbeConfigError stageProbeConfigRom(
    ProbeConfigStaging* staging, uint8_t oneBasedPosition,
    const uint8_t rom[kProbeRomBytes]);
ProbeConfigError finishProbeConfigStaging(const ProbeConfigStaging& staging,
                                          ProbeMapping* mapping);
void abortProbeConfigStaging(ProbeConfigStaging* staging);

const char* probeConfigErrorName(ProbeConfigError error);
const char* probeConfigStateName(ProbeConfigState state);
const char* probeConfigSlotName(ProbeConfigSlot slot);

}  // namespace sauna
