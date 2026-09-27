#pragma once

#include <stdint.h>

namespace sauna {

inline int16_t hottestValidCentiC(uint8_t validMask, const int16_t* centiC) {
  int16_t hottest = INT16_MIN;
  for (uint8_t index = 0; index < 8; ++index) {
    if ((validMask & (1U << index)) && centiC[index] > hottest)
      hottest = centiC[index];
  }
  return hottest;
}

template <typename Reading>
int16_t peakInRecordedWindow(const Reading* readings, uint16_t oldest,
                            uint16_t count, uint16_t capacity) {
  int16_t peak = INT16_MIN;
  for (uint16_t offset = 0; offset < count; ++offset) {
    const Reading& saved = readings[(oldest + offset) % capacity];
    const int16_t hottest = hottestValidCentiC(saved.validMask, saved.centiC);
    if (hottest > peak) peak = hottest;
  }
  return peak;
}

// Finishing at 40--45 C must not start another session on the same cooling
// curve. Require a representative cold observation before arming a new start.
// Duration-limited continuations never call requireCold().
class NormalCoolingRearm {
 public:
  void requireCold() { required_ = true; }
  bool mayStart(uint8_t validMask, const int16_t* centiC,
                int16_t startThreshold) {
    if (!required_) return true;
    uint8_t valid = 0;
    for (uint8_t bits = validMask; bits; bits >>= 1) valid += bits & 1U;
    if ((validMask & 1U) && valid >= 6 &&
        hottestValidCentiC(validMask, centiC) <= startThreshold)
      required_ = false;
    return false;
  }

 private:
  bool required_ = false;
};

}  // namespace sauna
