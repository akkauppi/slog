#pragma once
#include "slog_identity.h"
#include "sample_identity.h"
#include "radio_config.h"
#include "saunan_wire.h"
#include <string.h>
namespace sauna_link {
template<typename Reading, typename Block>
bool encodeSlogBlock(const Reading* readings, uint16_t count,
                 uint32_t triggerAtMs, uint32_t sequence,
                 Block* block, uint8_t* records, uint16_t start=0, uint16_t capacity=0) {
  using sauna_link::putLe;
  if (!readings || !count || count > 60 || !block || !records) return false;
  if (!capacity) capacity=count;
  if (capacity<count || start>=capacity) return false;
  for (uint16_t index=0; index<count; ++index) {
    const auto& r=readings[(start+index)%capacity];
    uint8_t* out=records+index*sauna_link::kSlogV3RecordBytes;
    putLe(out, static_cast<int32_t>(r.capturedAtMs-triggerAtMs)/1000, 4);
    for(size_t i=0;i<8;++i) putLe(out+4+2*i,r.centiC[i],2);
    out[20]=r.validMask; putLe(out+21,r.chipCentiC,2); putLe(out+23,r.statusFlags,2);
    putLe(out+25,r.identity.sequence,4); putLe(out+29,r.identity.monotonicMs,8);
    putLe(out+37,r.identity.skippedScheduleCount,4);
  }
  auto* bytes=reinterpret_cast<uint8_t*>(block);
  putLe(bytes,0x314B4C42U,4); putLe(bytes+4,sequence,4); putLe(bytes+8,count,2);
  const size_t payloadBytes=count*sauna_link::kSlogV3RecordBytes;
  putLe(bytes+10,payloadBytes,2);
  putLe(bytes+12,sauna_link::slogBlockCrc(bytes,records,payloadBytes),4);
  return true;
}

template<typename Header>
void encodeSlogHeader(const Header& h, uint64_t source, uint64_t nonce,
                    uint32_t mapping, bool counterValid, uint8_t* b, const char* commit, const char* version) {
  using sauna_link::putLe;
  memset(b,0,sauna_link::kSlogV3HeaderBytes); memcpy(b,"SAUNLOG1",8);
  putLe(b+8,3,2); putLe(b+10,sauna_link::kSlogV3HeaderBytes,2);
  putLe(b+12,h.sessionId,4); putLe(b+16,h.sampleIntervalMs,4); putLe(b+20,h.pretriggerMs,4);
  putLe(b+24,h.spacingCm,2); b[26]=h.sensorCount;
  putLe(b+28,h.startCentiC,2); putLe(b+30,h.endCentiC,2); putLe(b+32,h.peakDropCentiC,2);
  putLe(b+34,h.startHoldSeconds,4); putLe(b+38,h.endHoldSeconds,4); putLe(b+42,h.continuationOf,4);
  putLe(b+46,h.bootId,4); b[50]=h.resetReason; b[51]=h.continuationKind;
  b[52]=h.initialRtcSource; b[53]=h.continuationDelaySeconds; putLe(b+54,h.initialRtcHz,4);
  for(size_t i=0;i<8;++i) {
    memcpy(b+58+i*10,h.sensors[i].rom,8); putLe(b+66+i*10,h.sensors[i].relativeHeightCm,2);
  }
  putLe(b+138,source,8); putLe(b+146,nonce,8); putLe(b+154,mapping,4);
  putLe(b+158,1,2); b[160]=0xff; b[161]=counterValid?1:0;
  if(strlen(commit)>=40 && sauna_link::decodeHex(commit,40,b+162,20)) b[161]|=2;
  else memset(b+162,0,20);
  if(strstr(commit,"dirty")) b[161]|=4;
  memcpy(b+182,version,strlen(version)<16?strlen(version):15);
  putLe(b+200,sauna_wire::crc32IsoHdlc(b,200),4);
}

}  // namespace sauna_link
