#include "session_temperature.h"

#include <cassert>
#include <cstdint>

namespace {
struct Reading {
  uint8_t validMask;
  int16_t centiC[8];
};

void peakIncludesOnlyThePublishedWindow() {
  Reading ring[4] = {
      {0xff, {4400, 4300, 4200, 4100, 4000, 3000, 2000, 1000}},
      {0xff, {12000, 12000, 12000, 12000, 12000, 12000, 12000, 12000}},
      {0xff, {8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000}},
      {0xfe, {12500, 7200, 6000, 5000, 4000, 3000, 2000, 1000}},
  };
  // A wrapped pretrigger window consists of entries 2, 3 and trigger 0.
  // Neither invalid 125 C nor stale 120 C outside that window may set the peak.
  assert(sauna::peakInRecordedWindow(ring, 2, 3, 4) == 8000);
  assert(sauna::peakInRecordedWindow(ring, 0, 1, 4) == 4400);
  assert(sauna::peakInRecordedWindow(ring, 0, 0, 4) == INT16_MIN);
  assert(sauna::hottestValidCentiC(0, ring[0].centiC) == INT16_MIN);
  const int16_t negative[8] = {-1200, -800, 0, 0, 0, 0, 0, 0};
  assert(sauna::hottestValidCentiC(0x03, negative) == -800);
}

void normalCoolingNeedsAColdObservationBeforeAnotherStart() {
  sauna::NormalCoolingRearm rearm;
  int16_t temperatures[8] = {4300, 4300, 4300, 4300, 4300, 4300, 4300, 4300};
  // Initial warm start and duration-limited continuations remain eligible.
  assert(rearm.mayStart(0xff, temperatures, 4000));
  rearm.requireCold();
  for (unsigned sample = 0; sample < 360; ++sample)
    assert(!rearm.mayStart(0xff, temperatures, 4000));
  for (auto& temperature : temperatures) temperature = 4000;
  // Missing P1 or fewer than six valid probes cannot prove the sauna cooled.
  assert(!rearm.mayStart(0xfe, temperatures, 4000));
  assert(!rearm.mayStart(0x1f, temperatures, 4000));
  temperatures[7] = 4001;
  assert(!rearm.mayStart(0xff, temperatures, 4000));
  temperatures[7] = 4000;
  assert(!rearm.mayStart(0x3f, temperatures, 4000));
  temperatures[0] = 4100;
  assert(rearm.mayStart(0xff, temperatures, 4000));
  rearm.requireCold();
  assert(!rearm.mayStart(0xff, temperatures, 4000));
}
}  // namespace

int main() {
  peakIncludesOnlyThePublishedWindow();
  normalCoolingNeedsAColdObservationBeforeAnotherStart();
}
