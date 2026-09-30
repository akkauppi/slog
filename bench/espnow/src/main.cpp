#include <Arduino.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <bootloader_random.h>
#include "radio_link.h"

namespace {
sauna_link::RadioLink radio;
uint64_t nonce=0,nextAt=0;
uint32_t sequence=0,skipped=0;
bool paused=false,missing=false,overflow=false;
String line;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time())/1000; }
void command() {
  if(line=="BENCH TIMEOUT") radio.dropNextSendCallbackForTest();
  else if(line=="BENCH PAUSE") paused=true;
  else if(line=="BENCH RUN") paused=false;
  else if(line=="BENCH MISSING") missing=true;
  else if(line=="BENCH VALID") missing=false;
  else if(line!="BENCH STATUS") {
    if(!radio.command(line,false)) Serial.println("BENCH_ERROR invalid_command");
    return;
  }
  Serial.printf("BENCH_STATUS synthetic=1 storage=disabled paused=%u missing=%u sequence=%u heap=%u\n",
                paused,missing,sequence,ESP.getFreeHeap());
}
}
void setup() {
  Serial.begin(115200);
  enableLoopWDT();
  bootloader_random_enable();
  do { esp_fill_random(&nonce,sizeof(nonce)); } while(!nonce);
  bootloader_random_disable();
  radio.begin(true);
  nextAt=nowMs()+10000;
  Serial.println("BENCH_TRANSMITTER synthetic=1 storage=disabled expected_probes=8");
}
void loop() {
  for(unsigned budget=0;budget<64 && Serial.available();++budget) {
    const char c=static_cast<char>(Serial.read());
    if(c=='\r' || c=='\n') {
      if(overflow) Serial.println("BENCH_ERROR command_too_long");
      else if(line.length()) command();
      line="";overflow=false;
    } else if(!overflow && line.length()<127) line+=c;
    else { line="";overflow=true; }
  }
  const uint64_t now=nowMs();
  if(now>=nextAt) {
    nextAt+=10000;
    while(now>=nextAt) { nextAt+=10000; ++skipped; }
    ++sequence;
    sauna_wire::SampleV1 sample{};
    sample.sourceId=radio.localSourceId(); sample.bootNonce=nonce;
    sample.sequence=sequence; sample.senderMonotonicMs=now;
    sample.skippedScheduleCount=skipped;
    sample.mappingGeneration=1; sample.geometryId=1;
    sample.nominalPeriodMs=10000; sample.expectedProbeCount=8;
    sample.validMask=missing?0:255;
    sample.statusFlags=sauna_wire::kMappingReady|sauna_wire::kSyntheticSample;
    if(missing) sample.statusFlags|=sauna_wire::kSensorSetDegraded;
    for(size_t i=0;i<8;++i)
      sample.centiC[i]=missing?INT16_MIN:static_cast<int16_t>(4000+(sequence%40)*50-i*200);
    if(!paused) radio.offer(sample);
  }
  radio.poll();
  delay(1);
}
