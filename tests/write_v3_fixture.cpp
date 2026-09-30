#include "slog_v3.h"
#include <array>
#include <stdio.h>
#include <stdint.h>
struct Descriptor { uint8_t rom[8]{}; int16_t relativeHeightCm=0; };
struct Header {
  uint32_t sessionId=7,sampleIntervalMs=10000,pretriggerMs=600000;
  int16_t spacingCm=20; uint8_t sensorCount=8;
  int16_t startCentiC=4000,endCentiC=4500,peakDropCentiC=1500;
  uint32_t startHoldSeconds=30,endHoldSeconds=1800,continuationOf=0,bootId=42;
  uint8_t resetReason=1,continuationKind=0,initialRtcSource=1,continuationDelaySeconds=0;
  uint32_t initialRtcHz=32768;
  Descriptor sensors[8]{};
};
struct Reading {
  uint32_t capturedAtMs=0; int16_t centiC[8]{}; uint8_t validMask=255;
  int16_t chipCentiC=3500; uint16_t statusFlags=3;
  sauna_link::AcquisitionIdentity identity{};
};
int main(int argc,char** argv) {
  if(argc!=2) return 1;
  Header h{};
  for(unsigned i=0;i<8;++i) { h.sensors[i].rom[0]=0x28; h.sensors[i].rom[1]=i; h.sensors[i].relativeHeightCm=-20*i; }
  uint8_t header[204]{};
  sauna_link::encodeSlogHeader(h,0xaabbccddeeffULL,0xfedcba9876543210ULL,9,true,header,
      "0123456789abcdef0123456789abcdef01234567-dirty","0.4.0-dev");
  Reading readings[4]{};
  for(unsigned i=0;i<4;++i) {
    auto& r=readings[i]; r.capturedAtMs=10000+10000*i;
    for(auto& temp:r.centiC) temp=2000+10*i;
    r.identity.sequence=70+i; r.identity.monotonicMs=UINT64_C(9007199254740993)+10000*i;
    r.identity.skippedScheduleCount=2;
  }
  std::array<uint8_t,16> block{}; uint8_t records[4*41]{};
  if(!sauna_link::encodeSlogBlock(readings,4,30000,0,&block,records)) return 2;
  uint8_t footer[20]{};
  sauna_link::putLe(footer,0x31444e45,4); footer[4]=1;
  sauna_link::putLe(footer+8,4,4); sauna_link::putLe(footer+12,10,4);
  sauna_link::putLe(footer+16,sauna_wire::crc32IsoHdlc(footer,16),4);
  FILE* f=fopen(argv[1],"wb"); if(!f) return 3;
  fwrite(header,1,sizeof(header),f); fwrite(block.data(),1,block.size(),f);
  fwrite(records,1,sizeof(records),f); fwrite(footer,1,sizeof(footer),f);
  return fclose(f)!=0;
}
