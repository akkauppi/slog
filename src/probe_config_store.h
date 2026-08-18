#pragma once

#include <stdint.h>

#include "probe_config.h"

namespace sauna {

enum class ProbeConfigStoreError : uint8_t {
  None = 0,
  OpenFailed,
  ReadFailed,
  InvalidMapping,
  AmbiguousConfiguration,
  WriteFailed,
  ReadbackFailed,
};

class ProbeConfigStore {
 public:
  bool begin();
  ProbeConfigState state() const { return selection_.state; }
  bool ready() const { return probeConfigIsUsable(selection_); }
  const ProbeMapping& mapping() const { return selection_.mapping; }
  uint8_t validSlotCount() const { return selection_.validSlotCount; }
  uint32_t activeCrc() const { return activeCrc_; }

  bool staging() const { return staging_.active; }
  ProbeConfigError beginStaging(
      uint16_t geometryId = kProbeGeometryColumn8At20Cm);
  ProbeConfigError setStaged(uint8_t oneBasedPosition,
                             const uint8_t rom[kProbeRomBytes]);
  void abortStaging();
  const ProbeMapping& stagedMapping() const { return stagedMapping_; }
  uint8_t stagedMask() const { return staging_.setMask; }
  ProbeConfigStoreError commit();

  ProbeConfigStoreError lastStoreError() const { return lastStoreError_; }
  ProbeConfigError lastConfigError() const { return lastConfigError_; }

 private:
  bool loadSlots();

  ProbeConfigSelection selection_{};
  ProbeConfigStaging staging_{};
  ProbeMapping stagedMapping_{};
  uint32_t activeCrc_ = 0;
  ProbeConfigStoreError lastStoreError_ = ProbeConfigStoreError::None;
  ProbeConfigError lastConfigError_ = ProbeConfigError::None;
};

const char* probeConfigStoreErrorName(ProbeConfigStoreError error);

}  // namespace sauna
