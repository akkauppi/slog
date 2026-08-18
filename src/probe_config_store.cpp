#include "probe_config_store.h"

#include <nvs.h>

#include <string.h>

namespace sauna {
namespace {

constexpr char kProbeConfigNamespace[] = "probe_cfg";
constexpr char kProbeConfigSlotAKey[] = "slot_a";
constexpr char kProbeConfigSlotBKey[] = "slot_b";

bool readSlot(nvs_handle_t handle, const char* key, ProbeConfigSlotData* slot) {
  memset(slot, 0, sizeof(*slot));
  size_t storedLength = 0;
  const esp_err_t lengthResult =
      nvs_get_blob(handle, key, nullptr, &storedLength);
  if (lengthResult == ESP_ERR_NVS_NOT_FOUND) {
    return true;
  }
  if (lengthResult != ESP_OK) return false;
  slot->length = storedLength;
  if (storedLength != sizeof(slot->bytes)) return true;
  size_t readLength = sizeof(slot->bytes);
  return nvs_get_blob(handle, key, slot->bytes, &readLength) == ESP_OK &&
         readLength == sizeof(slot->bytes);
}

uint32_t slotCrc(const ProbeConfigSlotData& slot) {
  if (slot.length != sizeof(ProbeConfigRecordV1)) return 0;
  ProbeConfigRecordV1 record{};
  memcpy(&record, slot.bytes, sizeof(record));
  return record.crc;
}

}  // namespace

bool ProbeConfigStore::begin() {
  abortStaging();
  return loadSlots();
}

bool ProbeConfigStore::loadSlots() {
  ProbeConfigSlotData slotA{};
  ProbeConfigSlotData slotB{};
  nvs_handle_t handle = 0;
  if (nvs_open(kProbeConfigNamespace, NVS_READWRITE, &handle) != ESP_OK) {
    selection_ = {};
    selection_.state = ProbeConfigState::StorageUnavailable;
    activeCrc_ = 0;
    lastStoreError_ = ProbeConfigStoreError::OpenFailed;
    return false;
  }
  const bool readA = readSlot(handle, kProbeConfigSlotAKey, &slotA);
  const bool readB = readSlot(handle, kProbeConfigSlotBKey, &slotB);
  nvs_close(handle);

  // A readable-but-invalid slot can safely fall back to the other generation.
  // An I/O failure cannot: the unreadable slot may contain the newer valid
  // mapping, so selecting the older one would silently change probe identity.
  if (!readA || !readB) {
    selection_ = {};
    selection_.state = ProbeConfigState::StorageUnavailable;
    activeCrc_ = 0;
    lastStoreError_ = ProbeConfigStoreError::ReadFailed;
    return false;
  }

  selection_ = selectProbeConfigSlots(slotA, slotB);
  if (selection_.activeSlot == ProbeConfigSlot::A) {
    activeCrc_ = slotCrc(slotA);
  } else if (selection_.activeSlot == ProbeConfigSlot::B) {
    activeCrc_ = slotCrc(slotB);
  } else {
    activeCrc_ = 0;
  }
  lastStoreError_ = ProbeConfigStoreError::None;
  return true;
}

ProbeConfigError ProbeConfigStore::beginStaging(uint16_t geometryId) {
  abortProbeConfigStaging(&staging_);
  stagedMapping_ = {};
  if (geometryId != kProbeGeometryColumn8At20Cm) {
    lastConfigError_ = ProbeConfigError::BadGeometry;
    return lastConfigError_;
  }
  beginProbeConfigStaging(&staging_, geometryId);
  stagedMapping_.geometryId = geometryId;
  lastConfigError_ = ProbeConfigError::None;
  return lastConfigError_;
}

ProbeConfigError ProbeConfigStore::setStaged(
    uint8_t oneBasedPosition, const uint8_t rom[kProbeRomBytes]) {
  lastConfigError_ =
      stageProbeConfigRom(&staging_, oneBasedPosition, rom);
  if (lastConfigError_ == ProbeConfigError::None) {
    stagedMapping_.generation = 0;
    stagedMapping_.geometryId = staging_.geometryId;
    memcpy(stagedMapping_.roms, staging_.roms, sizeof(stagedMapping_.roms));
  }
  return lastConfigError_;
}

void ProbeConfigStore::abortStaging() {
  abortProbeConfigStaging(&staging_);
  stagedMapping_ = {};
  lastConfigError_ = ProbeConfigError::None;
}

ProbeConfigStoreError ProbeConfigStore::commit() {
  ProbeMapping candidate{};
  lastConfigError_ = finishProbeConfigStaging(staging_, &candidate);
  if (lastConfigError_ != ProbeConfigError::None) {
    lastStoreError_ = ProbeConfigStoreError::InvalidMapping;
    return lastStoreError_;
  }

  if (!loadSlots()) return lastStoreError_;
  if (selection_.state == ProbeConfigState::Ambiguous) {
    lastStoreError_ = ProbeConfigStoreError::AmbiguousConfiguration;
    return lastStoreError_;
  }
  const ProbeConfigSlot target = inactiveProbeConfigSlot(selection_);
  if (target == ProbeConfigSlot::None) {
    lastStoreError_ = ProbeConfigStoreError::AmbiguousConfiguration;
    return lastStoreError_;
  }

  candidate.generation = nextProbeConfigGeneration(selection_);
  const ProbeConfigRecordV1 record =
      makeProbeConfigRecord(candidate, candidate.generation);
  const char* key = target == ProbeConfigSlot::A ? kProbeConfigSlotAKey
                                                 : kProbeConfigSlotBKey;
  nvs_handle_t handle = 0;
  if (nvs_open(kProbeConfigNamespace, NVS_READWRITE, &handle) != ESP_OK) {
    lastStoreError_ = ProbeConfigStoreError::OpenFailed;
    return lastStoreError_;
  }
  const esp_err_t setResult = nvs_set_blob(handle, key, &record, sizeof(record));
  const esp_err_t commitResult =
      setResult == ESP_OK ? nvs_commit(handle) : setResult;
  nvs_close(handle);
  const bool writeReportedSuccess =
      setResult == ESP_OK && commitResult == ESP_OK;

  // Always reload after the write attempt. A commit may have reached flash even
  // if its final status was lost, so exact readback decides the outcome.
  const bool readbackSucceeded = loadSlots();
  if (!readbackSucceeded) {
    lastStoreError_ = ProbeConfigStoreError::ReadbackFailed;
    return lastStoreError_;
  }
  const bool selectedWrittenRecord =
      probeConfigIsUsable(selection_) && selection_.activeSlot == target &&
      selection_.mapping.generation == candidate.generation &&
      probeMappingsEqual(selection_.mapping, candidate) &&
      activeCrc_ == record.crc;
  if (!selectedWrittenRecord) {
    lastStoreError_ = writeReportedSuccess
                          ? ProbeConfigStoreError::ReadbackFailed
                          : ProbeConfigStoreError::WriteFailed;
    return lastStoreError_;
  }

  abortStaging();
  lastStoreError_ = ProbeConfigStoreError::None;
  return lastStoreError_;
}

const char* probeConfigStoreErrorName(ProbeConfigStoreError error) {
  switch (error) {
    case ProbeConfigStoreError::None:
      return "none";
    case ProbeConfigStoreError::OpenFailed:
      return "open_failed";
    case ProbeConfigStoreError::ReadFailed:
      return "read_failed";
    case ProbeConfigStoreError::InvalidMapping:
      return "invalid_mapping";
    case ProbeConfigStoreError::AmbiguousConfiguration:
      return "ambiguous_configuration";
    case ProbeConfigStoreError::WriteFailed:
      return "write_failed";
    case ProbeConfigStoreError::ReadbackFailed:
      return "readback_failed";
  }
  return "unknown";
}

}  // namespace sauna
