#include "radio_config.h"
#include "latest_sample.h"
#include "slog_identity.h"
#include <assert.h>
#include <stdio.h>
using namespace sauna_link;
int main() {
  RadioConfig c{}; uint8_t raw[kRadioConfigBytes]{};
  assert(encodeConfig(c,raw,sizeof(raw)));
  RadioConfig parsed{}; assert(decodeConfig(raw,sizeof(raw),parsed));
  c.mode=RadioMode::EspNow; c.channel=6; c.sourceId=0xaabbccddeeffULL;
  c.peer={{2,3,4,5,6,7}}; c.pmk.fill(7); c.lmk.fill(9);
  assert(encodeConfig(c,raw,sizeof(raw)));
  assert(decodeConfig(raw,sizeof(raw),parsed));
  assert(parsed.sourceId==c.sourceId && parsed.lmk==c.lmk && parsed.peer==c.peer);
  for(size_t i=0;i<sizeof(raw);++i) {
    raw[i]^=1; assert(!decodeConfig(raw,sizeof(raw),parsed));
    assert(parsed.mode==RadioMode::Off); raw[i]^=1;
  }
  for(size_t n=0;n<sizeof(raw);++n) assert(!decodeConfig(raw,n,parsed));
  c.channel=0; assert(!validConfig(c)); c.channel=6;
  c.peer[0]=1; assert(!validConfig(c)); c.peer[0]=2;
  c.lmk.fill(0); assert(!validConfig(c));
  c.mode=static_cast<RadioMode>(2); assert(!validConfig(c));
  uint8_t hex[2]{}; assert(decodeHex("0aFF",4,hex,2)); assert(hex[0]==10 && hex[1]==255);
  assert(!decodeHex("0xFF",4,hex,2)); assert(!decodeHex("0aFF",3,hex,2));
  sauna_wire::SampleV1 sample{};
  sample.sourceId=1; sample.bootNonce=1; sample.mappingGeneration=1;
  sample.geometryId=1; sample.expectedProbeCount=8; sample.nominalPeriodMs=10000;
  sample.statusFlags=sauna_wire::kMappingReady|sauna_wire::kSensorSetDegraded;
  sample.centiC.fill(INT16_MIN);
  LatestSample box; uint8_t packet[sauna_wire::kSampleV1Bytes]{};
  assert(!box.take(0,packet)); assert(box.offer(sample,10));
  sample.sequence=2; assert(box.offer(sample,20)); assert(box.replaced==1);
  assert(box.take(30,packet)); assert(sauna_wire::decodeDatagram(packet,sizeof(packet)).sample.sequence==2);
  assert(!box.take(30,packet)); assert(box.offer(sample,40));
  assert(!box.take(20041,packet)); assert(box.expired==1);
  assert(box.offer(sample,50)); box.clear(); assert(!box.take(50,packet));
  uint8_t header[12]{},payload[41]{};
  putLe(payload+29,UINT64_C(0xfedcba9876543210),8);
  assert(getLe(payload+29,8)==UINT64_C(0xfedcba9876543210));
  const auto crc=slogBlockCrc(header,payload,sizeof(payload));
  header[4]=1; assert(slogBlockCrc(header,payload,sizeof(payload))!=crc);
  puts("radio config, mailbox, and identity encoding tests passed");
}
