#pragma once
#include <stddef.h>
#include <stdint.h>
namespace sauna_link {
constexpr size_t kSlogV3HeaderBytes=204;
constexpr size_t kSlogV3RecordBytes=41;
inline void putLe(uint8_t* out,uint64_t value,size_t width) {
  for(size_t i=0;i<width;++i) out[i]=static_cast<uint8_t>(value>>(8*i));
}
inline uint64_t getLe(const uint8_t* in,size_t width) {
  uint64_t value=0; for(size_t i=0;i<width;++i) value|=uint64_t(in[i])<<(8*i);
  return value;
}
// V3 covers interpretation-critical sequence/count/length as well as payload.
inline uint32_t slogBlockCrc(const uint8_t* header,const uint8_t* payload,size_t size) {
  uint32_t crc=0xffffffffU;
  for(size_t i=0;i<12+size;++i) {
    crc^=i<12?header[i]:payload[i-12];
    for(unsigned bit=0;bit<8;++bit) crc=(crc>>1)^((crc&1)?0xedb88320U:0);
  }
  return crc^0xffffffffU;
}
}  // namespace sauna_link
