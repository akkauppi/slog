#include "power_policy.h"
#include <assert.h>
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
}
