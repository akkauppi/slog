#include "radio_config.h"
#include "saunan_wire.h"
#include <string.h>
namespace sauna_link {
namespace {
template<size_t N> bool any(const std::array<uint8_t,N>& a) {
  for (auto b : a) if (b) return true;
  return false;
}
int nibble(char c) {
  if(c>='0' && c<='9') return c-'0';
  if(c>='a' && c<='f') return c-'a'+10;
  if(c>='A' && c<='F') return c-'A'+10;
  return -1;
}
}
bool validConfig(const RadioConfig& c) {
  if(c.mode==RadioMode::Off)
    return !c.channel && !c.sourceId && !any(c.peer) && !any(c.pmk) && !any(c.lmk);
  return c.mode==RadioMode::EspNow && c.channel>=1 && c.channel<=11 &&
      c.sourceId && any(c.peer) && !(c.peer[0]&1) && any(c.pmk) && any(c.lmk);
}
bool encodeConfig(const RadioConfig& c,uint8_t* b,size_t n) {
  if(!b || n!=kRadioConfigBytes || !validConfig(c)) return false;
  memset(b,0,n); memcpy(b,"SRAD",4); b[4]=1;
  b[5]=static_cast<uint8_t>(c.mode); b[6]=c.channel;
  for(size_t i=0;i<8;++i) b[8+i]=static_cast<uint8_t>(c.sourceId>>(8*i));
  memcpy(b+16,c.peer.data(),6); memcpy(b+24,c.pmk.data(),16); memcpy(b+40,c.lmk.data(),16);
  const auto crc=sauna_wire::crc32IsoHdlc(b,56);
  for(size_t i=0;i<4;++i) b[56+i]=static_cast<uint8_t>(crc>>(8*i));
  return true;
}
bool decodeConfig(const uint8_t* b,size_t n,RadioConfig& out) {
  out={};
  if(!b || n!=kRadioConfigBytes || memcmp(b,"SRAD",4) || b[4]!=1 || b[7] || b[22] || b[23]) return false;
  uint32_t crc=0; for(size_t i=0;i<4;++i) crc|=uint32_t(b[56+i])<<(8*i);
  if(crc!=sauna_wire::crc32IsoHdlc(b,56)) return false;
  RadioConfig c{}; c.mode=static_cast<RadioMode>(b[5]); c.channel=b[6];
  for(size_t i=0;i<8;++i) c.sourceId|=uint64_t(b[8+i])<<(8*i);
  memcpy(c.peer.data(),b+16,6); memcpy(c.pmk.data(),b+24,16); memcpy(c.lmk.data(),b+40,16);
  if(!validConfig(c)) return false;
  out=c; return true;
}
bool decodeHex(const char* text,size_t length,uint8_t* bytes,size_t size) {
  if(!text || !bytes || length!=2*size) return false;
  for(size_t i=0;i<size;++i) {
    int high=nibble(text[2*i]),low=nibble(text[2*i+1]);
    if(high<0 || low<0) return false;
    bytes[i]=static_cast<uint8_t>(high*16+low);
  }
  return true;
}
}  // namespace sauna_link
