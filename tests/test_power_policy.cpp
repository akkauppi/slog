#include "power_policy.h"
#include <assert.h>

static void heartbeatJitter(bool test) {
  sauna::PowerPolicy p;
  const int16_t cold[8] = {2000,2000,2000,2000,2000,2000,2000,2000};
  // Exercise monotonic times beyond the 32-bit millis rollover, too. The
  // observation can be a millisecond later than the conversion schedule's
  // initial timestamp because main reads those clocks separately.
  const uint64_t origin = UINT64_C(0x100000000) + 300000;
  p.begin(origin - 300000, test);
  assert(p.observe(origin + 1,255,cold,false,true));
  assert(p.standby());
  const uint32_t heartbeat = test ? 300000 : 900000;
  const unsigned checksPerHeartbeat = heartbeat / 150000;
  const uint32_t jitter[] = {0,37,5,0,19,1,0};
  for (unsigned cycle = 1; cycle <= 7; ++cycle) {
    for (unsigned check = 1; check <= checksPerHeartbeat; ++check) {
      const uint64_t scheduled = origin +
          static_cast<uint64_t>(cycle - 1) * heartbeat + check * 150000;
      const bool due = check == checksPerHeartbeat;
      if (due) {
        // The radio should already be requested before the earliest accepted
        // heartbeat's 750 ms temperature conversion starts.
        assert(p.radioNeeded(scheduled - 1000));
      }
      assert(p.observe(scheduled + jitter[cycle - 1],255,cold,false,true) == due);
      assert(!p.radioNeeded(scheduled + jitter[cycle - 1]));
    }
  }

  // A long scheduler stall produces one fresh heartbeat, without a burst of
  // catch-up packets and without moving all future deadlines by the delay.
  const uint64_t resumed = origin + 10ULL * heartbeat + 4321;
  assert(p.observe(resumed,255,cold,false,true));
  assert(!p.observe(resumed + 1,255,cold,false,true));
  assert(!p.radioNeeded(resumed + 1));
  const uint64_t next = origin + 11ULL * heartbeat;
  assert(!p.observe(next - 2000,255,cold,false,true));
  assert(p.radioNeeded(next - 1000));
  assert(p.observe(next,255,cold,false,true));
  assert(!p.observe(next + 1,255,cold,false,true));
}

int main() {
  sauna::PowerPolicy p;
  int16_t t[8] = {2000,2000,2000,2000,2000,2000,2000,2000};
  p.begin(0);
  assert(p.observe(299999,255,t,false,true) && !p.standby());
  assert(p.observe(300000,255,t,false,true) && p.standby());
  assert(p.sampleMs()==150000 && p.heartbeatMs()==900000);
  assert(!p.observe(450000,255,t,false,true));
  assert(!p.radioNeeded(1198000) && p.radioNeeded(1199000));
  assert(p.observe(1200000,255,t,false,true));
  t[7]=3500;
  assert(p.observe(1350000,255,t,false,true) && !p.standby());
  assert(p.sampleMs()==10000); // any probe wakes, not only P1
  t[7]=2000;
  assert(!p.standby());
  p.observe(1650000,255,t,false,true); assert(p.standby());
  assert(p.observe(1800000,127,t,false,true) && !p.standby());
  p.observe(2100000,255,t,true,true); assert(!p.standby());
  p.observe(2400000,255,t,false,false); assert(!p.standby());
  p.setTest(true,UINT64_C(0x100000000));
  assert(p.heartbeatMs()==300000 && !p.standby());
  p.observe(UINT64_C(0x100000000)+300000,255,t,false,true);
  assert(p.standby());
  assert(!p.observe(UINT64_C(0x100000000)+450000,255,t,false,true));
  assert(p.observe(UINT64_C(0x100000000)+600000,255,t,false,true));
  p.wake(UINT64_C(0x100000000)+610000); assert(!p.standby());
  heartbeatJitter(false);
  heartbeatJitter(true);
}
