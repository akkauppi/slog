#pragma once
#include <stdint.h>

namespace sauna_link {
// A boot-local acquisition identity is assigned once, before sensor collection.
// Capture time denotes collection start after the conversion wait, not UTC.
struct AcquisitionIdentity {
  uint32_t sequence = 0;
  uint64_t monotonicMs = 0;
  uint32_t skippedScheduleCount = 0;
};
struct BootIdentity {
  uint64_t sourceId = 0;
  uint64_t nonce = 0;
  uint32_t counter = 0;
  bool counterValid = false;
};
}  // namespace sauna_link
