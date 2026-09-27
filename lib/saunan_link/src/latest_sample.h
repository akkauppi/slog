#pragma once
#include "saunan_wire.h"
#include <array>
#include <string.h>
namespace sauna_link {
// Loop-owned mailbox. A callback never accesses it. No heap, waits, or backlog.
class LatestSample {
 public:
  bool offer(const sauna_wire::SampleV1& sample, uint64_t now) {
    size_t n=0;
    if(sauna_wire::encodeSampleV1(sample,bytes_.data(),bytes_.size(),&n)!=sauna_wire::DecodeError::kNone) return false;
    if(pending_) ++replaced;
    pending_=true; offeredAt_=now; return true;
  }
  bool take(uint64_t now, uint8_t* out) {
    if(!pending_) return false;
    pending_=false;
    if(now<offeredAt_ || now-offeredAt_>20000) { ++expired; return false; }
    memcpy(out,bytes_.data(),bytes_.size()); return true;
  }
  bool hasPending() const { return pending_; }
  void clear() { pending_=false; }
  uint32_t replaced=0,expired=0;
 private:
  std::array<uint8_t,sauna_wire::kSampleV1Bytes> bytes_{};
  bool pending_=false;
  uint64_t offeredAt_=0;
};
}  // namespace sauna_link
