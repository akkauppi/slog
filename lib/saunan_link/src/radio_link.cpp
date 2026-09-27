#include "radio_link.h"
#include <Preferences.h>
#include <WiFi.h>
#include <esp_idf_version.h>
#include <esp_mac.h>
#include <esp_now.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <string.h>

namespace sauna_link {
namespace {
RadioLink* instance=nullptr;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time())/1000; }
#if ESP_IDF_VERSION_MAJOR >= 5
void receiveCallback(const esp_now_recv_info_t* info,const uint8_t* bytes,int size) {
  if(instance && info) instance->onReceive(info->src_addr,bytes,size,info->rx_ctrl ? info->rx_ctrl->rssi : INT16_MIN);
}
#else
void receiveCallback(const uint8_t* peer,const uint8_t* bytes,int size) {
  if(instance) instance->onReceive(peer,bytes,size);
}
#endif
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5,5,0)
void sendCallback(const esp_now_send_info_t*,esp_now_send_status_t status) {
#else
void sendCallback(const uint8_t*,esp_now_send_status_t status) {
#endif
  if(instance) instance->onSend(status==ESP_NOW_SEND_SUCCESS);
}
}
void RadioLink::begin(bool sender) {
  sender_=sender;
  if(esp_read_mac(localMac_,ESP_MAC_WIFI_STA)!=ESP_OK) { fault_=true; return; }
  for(auto byte:localMac_) localSourceId_=(localSourceId_<<8)|byte;
  Preferences prefs;
  uint8_t raw[kRadioConfigBytes]{};
  if(prefs.begin("sauna_radio",true)) {
    const auto length=prefs.getBytesLength("config");
    if(length) {
      if(length!=sizeof(raw) || prefs.getBytes("config",raw,sizeof(raw))!=sizeof(raw) ||
          !decodeConfig(raw,sizeof(raw),config_)) fault_=true;
    }
    prefs.end();
  }
  if(fault_ || config_.mode==RadioMode::Off) return;
  if((sender_ && config_.sourceId!=localSourceId_) || !memcmp(config_.peer.data(),localMac_,6)) {
    config_={}; fault_=true; return;
  }
  receiveQueue_=xQueueCreate(1,sizeof(ReceivedDatagram));
  sendQueue_=xQueueCreate(1,sizeof(bool));
  if(!receiveQueue_ || !sendQueue_) { fault_=true; return; }
  instance=this;
  if(xTaskCreate(recoveryWorker,"sauna_radio",4096,this,1,&recoveryTask_)!=pdPASS) {
    fault_=true; return;
  }
  if(!startTransport()) requestRecovery();
}
bool RadioLink::startTransport() {
  WiFi.persistent(false);
  if(!WiFi.mode(WIFI_STA) || esp_wifi_set_ps(WIFI_PS_NONE)!=ESP_OK ||
      esp_wifi_set_channel(config_.channel,WIFI_SECOND_CHAN_NONE)!=ESP_OK ||
      esp_now_init()!=ESP_OK) {
    fault_=true; return false;
  }
  transportInitialized_=true;
  esp_now_peer_info_t peer{};
  memcpy(peer.peer_addr,config_.peer.data(),6);
  memcpy(peer.lmk,config_.lmk.data(),16);
  peer.channel=config_.channel; peer.ifidx=WIFI_IF_STA; peer.encrypt=true;
  if(esp_now_set_pmk(config_.pmk.data())!=ESP_OK || esp_now_add_peer(&peer)!=ESP_OK ||
      esp_now_register_recv_cb(receiveCallback)!=ESP_OK || esp_now_register_send_cb(sendCallback)!=ESP_OK) {
    fault_=true; return false;
  }
  callbacksEnabled_=true;
  fault_=false; enabled_=true;
  return true;
}
bool RadioLink::stopTransport() {
  enabled_=false; callbacksEnabled_=false;
  if(transportInitialized_) {
    esp_now_unregister_recv_cb(); esp_now_unregister_send_cb();
    if(esp_now_deinit()!=ESP_OK) return false;
    transportInitialized_=false;
  }
  // Stop the Wi-Fi task/driver before reusing callback queues and send state.
  // Queues remain allocated for the lifetime of this link, including shutdown.
  if(!WiFi.mode(WIFI_OFF)) return false;
  if(receiveQueue_) xQueueReset(receiveQueue_);
  if(sendQueue_) xQueueReset(sendQueue_);
  return true;
}
void RadioLink::stop() {
  stopTransport();
  busy_=false; pending_.clear();
}
bool RadioLink::requestRecovery() {
  if(powerWork_ || sleeping_ || !recoveryTask_ || restartRequired_ || config_.mode!=RadioMode::EspNow) return false;
  if(recovering_) return true;
  recovering_=true;
  retryAt_=nowMs(); retryDelayMs_=1000;
  return true;
}
void RadioLink::recoveryWorker(void* context) {
  auto* self=static_cast<RadioLink*>(context);
  for(;;) {
    ulTaskNotifyTake(pdTRUE,portMAX_DELAY);
    bool ok = false;
    if (self->workerOperation_ == 1) {
      ok = self->stopTransport();
      if (ok) self->sleeping_ = true;
    } else if (self->workerOperation_ == 2) {
      ok = self->startTransport();
      self->sleeping_ = false;
    } else {
      ++self->recoveryAttempts_;
      ok = self->stopTransport() && self->startTransport();
      if (ok) ++self->recoveries_;
    }
    if (!ok) self->fault_ = true;
    // Publish completion only after SDK teardown/startup and all queue work.
    self->workerBusy_=false;
  }
}
void RadioLink::onReceive(const uint8_t* peer,const uint8_t* bytes,int size,int16_t rssi) {
  if(!callbacksEnabled_ || !receiveQueue_ || sender_ || !peer || !bytes || size<20 || size>250 ||
      memcmp(peer,config_.peer.data(),6)) return;
  ReceivedDatagram packet{};
  packet.rssiDbm=rssi;
  packet.size=static_cast<uint16_t>(size); packet.receivedAtMs=nowMs();
  memcpy(packet.peer,peer,6); memcpy(packet.bytes,bytes,size);
  xQueueOverwrite(receiveQueue_,&packet);
}
void RadioLink::onSend(bool success) {
#ifdef SAUNA_RADIO_BENCH_TEST
  if(dropNextCallback_.exchange(false)) return;
#endif
  if(callbacksEnabled_ && sendQueue_) xQueueOverwrite(sendQueue_,&success);
}
void RadioLink::offer(const sauna_wire::SampleV1& sample) {
  if(awakeWanted_ && !restartRequired_ && config_.mode==RadioMode::EspNow && !recovering_ && sender_ && sample.sourceId==localSourceId_ && pending_.offer(sample,nowMs())) ++offered_;
}
void RadioLink::poll() {
  const uint64_t now=nowMs();
  if (powerWork_) {
    if (workerBusy_) return;
    powerWork_ = false;
    if (fault_) { awakeWanted_ = true; sleeping_ = false; requestRecovery(); }
  }
  if (!recovering_ && sender_ && recoveryTask_ && !restartRequired_ &&
      (awakeWanted_ || pending_.hasPending()) == sleeping_.load() && !busy_ &&
      (sleeping_ || !pending_.hasPending())) {
    workerOperation_ = (awakeWanted_ || pending_.hasPending()) ? 2 : 1;
    powerWork_ = true; workerBusy_ = true;
    xTaskNotifyGive(recoveryTask_);
    return;
  }
  if (sleeping_) return;
  if(recovering_) {
    if(workerBusy_) return;
    if(enabled_ && !fault_ && retryAt_==UINT64_MAX) {
      recovering_=false; retryDelayMs_=1000;
    } else {
      if(retryAt_==UINT64_MAX) {
        retryAt_=now+retryDelayMs_;
        retryDelayMs_=retryDelayMs_<30000 ? retryDelayMs_*2 : 60000;
      }
      if(now>=retryAt_) {
        busy_=false; pending_.clear();
        retryAt_=UINT64_MAX; workerOperation_=0; workerBusy_=true;
        xTaskNotifyGive(recoveryTask_);
      }
      return;
    }
  }
  if(!enabled_ || !sender_) return;
  bool success=false;
  if(busy_ && xQueueReceive(sendQueue_,&success,0)==pdTRUE) {
    busy_=false; if(success) ++sent_; else ++failed_;
  }
  if(busy_ && now-sentAt_>=2000) {
    // Stop offering samples until the worker has rebuilt the radio stack.
    // Acquisition, identity and log state are untouched.
    ++timeouts_; fault_=true; requestRecovery(); return;
  }
  if(!busy_ && pending_.take(now,inFlight_)) {
    xQueueReset(sendQueue_);
    sentAt_=now; busy_=true;
    if(esp_now_send(config_.peer.data(),inFlight_,sizeof(inFlight_))!=ESP_OK) {
      busy_=false; ++failed_;
    }
  }
}
bool RadioLink::receive(ReceivedDatagram& packet) {
  return enabled_ && !recovering_ && !sender_ && xQueueReceive(receiveQueue_,&packet,0)==pdTRUE;
}
bool RadioLink::save(const RadioConfig& config) {
  uint8_t raw[kRadioConfigBytes]{},check[kRadioConfigBytes]{};
  if(!encodeConfig(config,raw,sizeof(raw))) return false;
  Preferences prefs;
  if(!prefs.begin("sauna_radio",false)) return false;
  const bool ok=prefs.putBytes("config",raw,sizeof(raw))==sizeof(raw) &&
      prefs.getBytesLength("config")==sizeof(raw) &&
      prefs.getBytes("config",check,sizeof(check))==sizeof(check) && !memcmp(raw,check,sizeof(raw));
  prefs.end();
  // An uncertain NVS write also requires reboot before any more provisioning.
  restartRequired_=true; stop(); if(!ok) fault_=true;
  return ok;
}
bool RadioLink::command(const String& line,bool recordingActive) {
  if(!line.startsWith("RADIO")) return false;
  if(line=="RADIO STATUS") {
    Serial.printf("RADIO_STATUS protocol=1 mac=%02X%02X%02X%02X%02X%02X source=%016llX mode=%s active=%u fault=%u restart_required=%u channel=%u offered=%u sent=%u failed=%u replaced=%u expired=%u timeouts=%u recovering=%u recovery_attempts=%u recoveries=%u sleeping=%u role=%s\n",
        localMac_[0],localMac_[1],localMac_[2],localMac_[3],localMac_[4],localMac_[5],
        static_cast<unsigned long long>(localSourceId_),config_.mode==RadioMode::EspNow?"espnow":"off",
        enabled_.load(),fault_.load(),restartRequired_,config_.channel,offered_,sent_,failed_,pending_.replaced,pending_.expired,timeouts_,recovering_.load(),recoveryAttempts_.load(),recoveries_.load(),sleeping_.load(),sender_?"logger":"receiver");
  } else if(line=="RADIO RECOVER") {
    Serial.printf("RADIO_RECOVER ok=%u\n",requestRecovery());
  } else if(recovering_ || powerWork_) Serial.println("RADIO_ERROR recovery_in_progress");
  else if(recordingActive) Serial.println("RADIO_ERROR active_session");
  else if(line=="RADIO REBOOT") { Serial.println("RADIO_REBOOT ok=1"); delay(20); ESP.restart(); }
  else if(restartRequired_) Serial.println("RADIO_ERROR restart_required");
  else if(line=="RADIO OFF") {
    Serial.printf("RADIO_CONFIG ok=%u restart_required=%u\n",save(RadioConfig{}),1);
  } else if(line.length()==6+2*kRadioConfigBytes && line.startsWith("RADIO ")) {
    uint8_t raw[kRadioConfigBytes]{}; RadioConfig candidate{};
    if(!decodeHex(line.c_str()+6,line.length()-6,raw,sizeof(raw)) || !decodeConfig(raw,sizeof(raw),candidate) ||
        (candidate.mode==RadioMode::EspNow && ((sender_ && candidate.sourceId!=localSourceId_) || !memcmp(candidate.peer.data(),localMac_,6))))
      Serial.println("RADIO_ERROR invalid_config");
    else Serial.printf("RADIO_CONFIG ok=%u restart_required=%u\n",save(candidate),1);
  } else Serial.println("RADIO_ERROR invalid_command");
  return true;
}
}  // namespace sauna_link
