#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>

#include <esp_idf_version.h>
#include <esp_private/esp_clk.h>
#include <soc/rtc.h>

#include "session_logger.h"

namespace {
// XIAO header pin D2 is ESP32-C3 GPIO4. Arduino-as-IDF-component builds do not
// import the board variant aliases, so use the verified electrical GPIO.
constexpr uint8_t kOneWirePin = 4;
constexpr uint8_t kResolutionBits = 12;
constexpr uint32_t kConversionTimeMs = 750;

struct SensorDefinition {
  uint8_t position;
  DeviceAddress address;
};

constexpr SensorDefinition kSensors[sauna::kSensorCount] = {
    {1, {0x28, 0x25, 0xE1, 0xBD, 0, 0, 0, 0x58}},
    {2, {0x28, 0x56, 0xBE, 0x53, 0, 0, 0, 0x3F}},
    {3, {0x28, 0x7C, 0x38, 0xC0, 0, 0, 0, 0x78}},
    {4, {0x28, 0xD9, 0x2E, 0x50, 0, 0, 0, 0xCE}},
    {5, {0x28, 0x9A, 0xBC, 0x52, 0, 0, 0, 0xD1}},
    {6, {0x28, 0xCD, 0x19, 0x52, 0, 0, 0, 0x9B}},
    {7, {0x28, 0x93, 0x93, 0x52, 0, 0, 0, 0xD0}},
    {8, {0x28, 0x01, 0xF3, 0x52, 0, 0, 0, 0x1E}},
};

OneWire oneWire(kOneWirePin);
DallasTemperature sensors(&oneWire);
sauna::SessionLogger logger;
uint32_t conversionStartedAt = 0;
uint32_t nextConversionAt = 0;
uint32_t sampleSequence = 0;
uint8_t consecutiveEmptySamples = 0;
bool conversionInProgress = false;
bool rtcCrystalFallbackObserved = false;

const char* slowClockSourceName(rtc_slow_freq_t source) {
  switch (source) {
    case RTC_SLOW_FREQ_RTC:
      return "internal_rc";
    case RTC_SLOW_FREQ_32K_XTAL:
      return "external_32k_xtal";
    case RTC_SLOW_FREQ_8MD256:
      return "internal_8m_div256";
    default:
      return "unknown";
  }
}

void printRtcSlowClockDiagnostic() {
  const rtc_slow_freq_t source = rtc_clk_slow_freq_get();
  const uint32_t reportedHz = rtc_clk_slow_freq_get_hz();
  const uint32_t calibration = rtc_clk_cal(RTC_CAL_RTC_MUX, 1024);
  const uint32_t measuredHz = calibration
                                  ? static_cast<uint32_t>(
                                        (1000000ULL << RTC_CLK_CAL_FRACT) /
                                        calibration)
                                  : 0;
  const uint32_t startupCalibration = esp_clk_slowclk_cal_get();
  if (Serial) Serial.printf(
      "rtc_slow_clk source=%s enum=%u reported_hz=%u measured_hz=%u "
      "calibration=%u startup_calibration=%u xtal32k_enabled=%u "
      "idf=%d.%d.%d\n",
      slowClockSourceName(source), static_cast<unsigned>(source), reportedHz,
      measuredHz, calibration, startupCalibration, rtc_clk_32k_enabled(),
      ESP_IDF_VERSION_MAJOR, ESP_IDF_VERSION_MINOR, ESP_IDF_VERSION_PATCH);
}

void startConversion(uint32_t now) {
  sensors.requestTemperatures();
  conversionStartedAt = now;
  conversionInProgress = true;
}

void collectSample(uint32_t now) {
  sauna::SensorReading reading{};
  reading.capturedAtMs = now;
  reading.chipCentiC = INT16_MIN;
  ++sampleSequence;
  if (Serial)
    Serial.printf("TELEM sample=%lu", static_cast<unsigned long>(sampleSequence));
  for (uint8_t index = 0; index < sauna::kSensorCount; ++index) {
    const float temperature = sensors.getTempC(kSensors[index].address);
    const bool valid = temperature != DEVICE_DISCONNECTED_C &&
                       temperature >= -55.0f && temperature <= 125.0f;
    if (valid) {
      reading.validMask |= 1U << index;
      reading.centiC[index] = static_cast<int16_t>(lroundf(temperature * 100.0f));
      if (Serial) Serial.printf(" p%u=%.2f", kSensors[index].position, temperature);
    } else {
      reading.centiC[index] = INT16_MIN;
      if (Serial) Serial.printf(" p%u=NA", kSensors[index].position);
    }
  }

  const float chipTemperature = temperatureRead();
  if (!isnan(chipTemperature)) {
    reading.chipCentiC =
        static_cast<int16_t>(lroundf(chipTemperature * 100.0f));
    reading.statusFlags |= sauna::ChipTemperatureValid;
  }
  const rtc_slow_freq_t rtcSource = rtc_clk_slow_freq_get();
  if (rtcSource == RTC_SLOW_FREQ_32K_XTAL) {
    reading.statusFlags |= sauna::RtcExternalCrystalActive;
  } else {
    rtcCrystalFallbackObserved = true;
  }
  if (rtcCrystalFallbackObserved)
    reading.statusFlags |= sauna::RtcCrystalFallbackObserved;
  if (reading.validMask != 0xFFU)
    reading.statusFlags |= sauna::SensorSetDegraded;

  if (Serial) {
    if (reading.statusFlags & sauna::ChipTemperatureValid)
      Serial.printf(" chip=%.2f", chipTemperature);
    Serial.printf(" rtc=%s", slowClockSourceName(rtcSource));
    Serial.println();
  }
  logger.addSample(reading);

  if (reading.validMask == 0) {
    if (++consecutiveEmptySamples >= 6) {
      sensors.begin();
      sensors.setResolution(kResolutionBits);
      sensors.setWaitForConversion(false);
      consecutiveEmptySamples = 0;
      if (Serial) Serial.println("one_wire_event=reinitialized reason=no_valid_probes");
    }
  } else {
    consecutiveEmptySamples = 0;
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  enableLoopWDT();
  if (Serial) Serial.println("sauna logger v2: Wi-Fi disabled");
  printRtcSlowClockDiagnostic();
  sensors.begin();
  sensors.setResolution(kResolutionBits);
  sensors.setWaitForConversion(false);
  if (Serial)
    Serial.printf("one_wire_discovered=%u expected=%u\n", sensors.getDeviceCount(),
                  sauna::kSensorCount);
  logger.begin();
  const uint32_t now = millis();
  startConversion(now);
  nextConversionAt = now + sauna::kSampleIntervalMs;
}

void loop() {
  const uint32_t now = millis();
  logger.handleSerial();
  if (conversionInProgress &&
      static_cast<uint32_t>(now - conversionStartedAt) >= kConversionTimeMs) {
    collectSample(now);
    conversionInProgress = false;
  }
  if (!conversionInProgress &&
      static_cast<int32_t>(now - nextConversionAt) >= 0) {
    startConversion(now);
    do {
      nextConversionAt += sauna::kSampleIntervalMs;
    } while (static_cast<int32_t>(now - nextConversionAt) >= 0);
  }
}
