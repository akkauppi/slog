#pragma once
#include <Arduino.h>
#include <atomic>
#include <freertos/task.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "latest_sample.h"
#include "radio_config.h"
namespace sauna_link {
struct ReceivedDatagram {
  uint8_t bytes[sauna_wire::kMaximumDatagramBytes]{};
  uint16_t size=0;
  uint64_t receivedAtMs=0;
  uint8_t peer[6]{};
  int16_t rssiDbm=INT16_MIN;
};
class RadioLink {
 public:
  void begin(bool sender);
  bool command(const String& line, bool recordingActive);
  void offer(const sauna_wire::SampleV1& sample);
  void poll();
  // Loop-owned request; driver teardown/startup stays on the radio worker.
  void setAwake(bool awake) { awakeWanted_ = awake; }
  bool sleeping() const { return sleeping_; }
  bool safeToSleep() const { return sleeping_ && !workerBusy_ && !recovering_ && !fault_; }

  bool receive(ReceivedDatagram& packet);
  const RadioConfig& config() const { return config_; }
  bool enabled() const { return enabled_; }
  bool fault() const { return fault_; }
  bool recovering() const { return recovering_; }
  uint32_t recoveryAttempts() const { return recoveryAttempts_; }
  uint32_t recoveries() const { return recoveries_; }
  bool requestRecovery();
#ifdef SAUNA_RADIO_BENCH_TEST
  void dropNextSendCallbackForTest() { dropNextCallback_=true; }
#endif
  bool restartRequired() const { return restartRequired_; }
  uint64_t localSourceId() const { return localSourceId_; }
  // Called only by SDK callbacks; bounded queue operations, no application work.
  void onReceive(const uint8_t* peer,const uint8_t* bytes,int size,int16_t rssi=INT16_MIN);
  void onSend(bool success);
 private:
#ifdef SAUNA_RADIO_BENCH_TEST
  std::atomic<bool> dropNextCallback_{false};
#endif
  RadioConfig config_{};
  LatestSample pending_{};
  uint8_t inFlight_[sauna_wire::kSampleV1Bytes]{};
  QueueHandle_t receiveQueue_=nullptr,sendQueue_=nullptr;
  uint64_t localSourceId_=0,sentAt_=0;
  uint8_t localMac_[6]{};
  bool sender_=false,busy_=false,restartRequired_=false;
  std::atomic<bool> enabled_{false},fault_{false},recovering_{false};
  std::atomic<bool> callbacksEnabled_{false},workerBusy_{false};
  std::atomic<uint32_t> recoveryAttempts_{0},recoveries_{0};
  TaskHandle_t recoveryTask_=nullptr;
  bool transportInitialized_=false;
  bool awakeWanted_=true, powerWork_=false;
  std::atomic<bool> sleeping_{false};
  uint8_t workerOperation_=0; // 0 recovery, 1 suspend, 2 resume

  uint64_t retryAt_=0;
  uint32_t retryDelayMs_=1000;
  static void recoveryWorker(void* context);
  bool startTransport();
  bool stopTransport();
  uint32_t offered_=0,sent_=0,failed_=0,timeouts_=0;
  void stop();
  bool save(const RadioConfig& config);
};
}  // namespace sauna_link
