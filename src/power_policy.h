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
    if (!standby_ || !wasStandby) {
      nextHeartbeat_ = now + heartbeatMs();
      return true;
    }
    const uint64_t dueThrough = now + kHeartbeatJitterMs;
    if (dueThrough < nextHeartbeat_) return false;
    // Keep the deadline on its original cadence: a late collection must not
    // make the next on-time collection miss an entire 150-second cold check.
    // Consume missed deadlines together and send only the current reading.
    nextHeartbeat_ += ((dueThrough - nextHeartbeat_) / heartbeatMs() + 1) * heartbeatMs();
    return true;
  }
  bool standby() const { return standby_; }
  bool test() const { return test_; }
  uint32_t sampleMs() const { return standby_ ? kColdCheckMs : kLiveMs; }
  uint32_t heartbeatMs() const { return test_ ? 300000 : 900000; }
  bool radioNeeded(uint64_t now) const {
    // Start before even the earliest accepted heartbeat's conversion. Driver
    // startup runs on the radio worker while that conversion is in progress.
    return !standby_ || now + 1000 + kHeartbeatJitterMs >= nextHeartbeat_;
  }
 private:
  // Collection and conversion scheduling read the clock separately. Allow
  // small timing jitter, never a whole cold-check interval, at the deadline.
  static constexpr uint32_t kHeartbeatJitterMs = 100;
  bool standby_ = false, test_ = false;
  uint64_t awakeUntil_ = 0, nextHeartbeat_ = 0;
};
}  // namespace sauna
