#pragma once
#include <stdint.h>

namespace sauna {
// A slow cold check is a wake-up decision, never a ten-second log record.
class PowerPolicy {
 public:
  static constexpr uint32_t kLiveMs = 10000;
  static constexpr uint32_t kColdCheckMs = 150000;
  static constexpr uint32_t kWindowMs = 300000;
  void begin(uint64_t now, bool test = false) { test_ = test; wake(now); }
  void wake(uint64_t now) { standby_ = false; awakeUntil_ = now + kWindowMs; }
  void setTest(bool test, uint64_t now) { test_ = test; wake(now); }
  bool observe(uint64_t now, uint8_t mask, const int16_t* temperatures,
               bool recording, bool ready) {
    bool cold = mask == 255 && ready && !recording;
    for (unsigned i = 0; i < 8; ++i)
      if ((mask & (1U << i)) && temperatures[i] >= 3500) cold = false;
    const bool wasStandby = standby_;
    if (!cold) wake(now);
    else if (now >= awakeUntil_) standby_ = true;
    const bool send = !standby_ || !wasStandby || now >= nextHeartbeat_;
    if (send) nextHeartbeat_ = now + heartbeatMs();
    return send;
  }
  bool standby() const { return standby_; }
  bool test() const { return test_; }
  uint32_t sampleMs() const { return standby_ ? kColdCheckMs : kLiveMs; }
  uint32_t heartbeatMs() const { return test_ ? 300000 : 900000; }
  bool radioNeeded(uint64_t now) const {
    // Start the transport before the conversion whose result is the heartbeat.
    return !standby_ || now + 1000 >= nextHeartbeat_;
  }
 private:
  bool standby_ = false, test_ = false;
  uint64_t awakeUntil_ = 0, nextHeartbeat_ = 0;
};
}  // namespace sauna
