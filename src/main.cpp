#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>

#include <esp_idf_version.h>
#include <esp_ota_ops.h>
#include <esp_private/esp_clk.h>
#include <soc/rtc.h>

#include "probe_config_store.h"
#include "session_logger.h"

#ifndef SAUNA_FIRMWARE_VERSION
#define SAUNA_FIRMWARE_VERSION "0.3.0-dev"
#endif

#ifndef SAUNA_SOURCE_COMMIT
#define SAUNA_SOURCE_COMMIT "unknown"
#endif

namespace {
// XIAO header pin D2 is ESP32-C3 GPIO4. Arduino-as-IDF-component builds do not
// import the board variant aliases, so use the verified electrical GPIO.
constexpr uint8_t kOneWirePin = 4;
constexpr uint8_t kResolutionBits = 12;
constexpr uint32_t kConversionTimeMs = 750;
constexpr uint8_t kMaximumDiscoveredProbes = 16;
constexpr uint32_t kCommissioningTimeoutMs = 10UL * 60UL * 1000UL;
constexpr char kGeometryName[] = "column8_20cm_v1";
constexpr char kPartitionLayoutId[] = "sauna_ota_v1";

struct DiscoveredProbe {
  uint8_t rom[sauna::kProbeRomBytes];
  float temperatureC;
  bool temperatureValid;
};

struct DiscoverySnapshot {
  uint8_t busCount;
  uint8_t count;
  bool overflow;
  DiscoveredProbe probes[kMaximumDiscoveredProbes];
};

OneWire oneWire(kOneWirePin);
DallasTemperature sensors(&oneWire);
sauna::SessionLogger logger;
sauna::ProbeConfigStore probeConfig;
sauna::ProbeMapping activeProbeMapping{};
DiscoverySnapshot latestDiscovery{};
uint32_t conversionStartedAt = 0;
uint32_t nextConversionAt = 0;
uint32_t sampleSequence = 0;
uint32_t commissioningLastActivityAt = 0;
uint8_t consecutiveEmptySamples = 0;
bool conversionInProgress = false;
bool rtcCrystalFallbackObserved = false;
bool activeProbeMappingReady = false;
bool probeConfigRestartRequired = false;
bool commissioningLocked = false;

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

bool validProbeTemperature(float temperature) {
  return temperature != DEVICE_DISCONNECTED_C && temperature >= -55.0f &&
         temperature <= 125.0f;
}

void configureSensors() {
  sensors.begin();
  sensors.setResolution(kResolutionBits);
  sensors.setWaitForConversion(false);
}

void romToText(const uint8_t rom[sauna::kProbeRomBytes], char text[17]) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  for (size_t index = 0; index < sauna::kProbeRomBytes; ++index) {
    text[index * 2] = kHex[rom[index] >> 4];
    text[index * 2 + 1] = kHex[rom[index] & 0x0F];
  }
  text[16] = '\0';
}

int hexDigit(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  return -1;
}

bool parseRomText(const String& text,
                  uint8_t rom[sauna::kProbeRomBytes]) {
  if (text.length() != sauna::kProbeRomBytes * 2) return false;
  for (size_t index = 0; index < sauna::kProbeRomBytes; ++index) {
    const int high = hexDigit(text[index * 2]);
    const int low = hexDigit(text[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    rom[index] = static_cast<uint8_t>((high << 4) | low);
  }
  return sauna::probeRomIsValid(rom);
}

uint8_t mappedPosition(const uint8_t rom[sauna::kProbeRomBytes]) {
  if (!activeProbeMappingReady) return 0;
  for (uint8_t index = 0; index < sauna::kProbeCount; ++index) {
    if (memcmp(activeProbeMapping.roms[index], rom, sauna::kProbeRomBytes) == 0)
      return index + 1;
  }
  return 0;
}

void sortDiscovery(DiscoverySnapshot* snapshot) {
  if (!snapshot) return;
  for (uint8_t left = 0; left < snapshot->count; ++left) {
    for (uint8_t right = left + 1; right < snapshot->count; ++right) {
      if (memcmp(snapshot->probes[left].rom, snapshot->probes[right].rom,
                 sauna::kProbeRomBytes) > 0) {
        const DiscoveredProbe temporary = snapshot->probes[left];
        snapshot->probes[left] = snapshot->probes[right];
        snapshot->probes[right] = temporary;
      }
    }
  }
}

void scanProbeBus(bool freshTemperatures) {
  conversionInProgress = false;
  configureSensors();
  if (freshTemperatures) {
    sensors.requestTemperatures();
    delay(kConversionTimeMs);
  }

  DiscoverySnapshot snapshot{};
  snapshot.busCount = sensors.getDeviceCount();
  snapshot.overflow = snapshot.busCount > kMaximumDiscoveredProbes;
  const uint8_t inspected =
      min(snapshot.busCount, kMaximumDiscoveredProbes);
  for (uint8_t index = 0; index < inspected; ++index) {
    DeviceAddress address{};
    if (!sensors.getAddress(address, index) ||
        !sauna::probeRomIsValid(address)) {
      continue;
    }
    bool duplicate = false;
    for (uint8_t existing = 0; existing < snapshot.count; ++existing) {
      duplicate |= memcmp(snapshot.probes[existing].rom, address,
                          sauna::kProbeRomBytes) == 0;
    }
    if (duplicate || snapshot.count == kMaximumDiscoveredProbes) {
      snapshot.overflow = true;
      continue;
    }
    DiscoveredProbe& discovered = snapshot.probes[snapshot.count++];
    memcpy(discovered.rom, address, sauna::kProbeRomBytes);
    discovered.temperatureC = sensors.getTempC(address);
    discovered.temperatureValid =
        validProbeTemperature(discovered.temperatureC);
  }
  sortDiscovery(&snapshot);
  latestDiscovery = snapshot;

  uint8_t mappedValid = 0;
  for (uint8_t index = 0; index < latestDiscovery.count; ++index) {
    if (mappedPosition(latestDiscovery.probes[index].rom) &&
        latestDiscovery.probes[index].temperatureValid) {
      ++mappedValid;
    }
  }
  logger.setProbeBusStatus(latestDiscovery.count, mappedValid);
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
    float temperature = DEVICE_DISCONNECTED_C;
    if (activeProbeMappingReady) {
      temperature = sensors.getTempC(activeProbeMapping.roms[index]);
    }
    const bool valid = validProbeTemperature(temperature);
    if (valid) {
      reading.validMask |= 1U << index;
      reading.centiC[index] = static_cast<int16_t>(lroundf(temperature * 100.0f));
      if (Serial) Serial.printf(" p%u=%.2f", index + 1, temperature);
    } else {
      reading.centiC[index] = INT16_MIN;
      if (Serial) Serial.printf(" p%u=NA", index + 1);
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
  logger.setProbeBusStatus(
      latestDiscovery.count,
      static_cast<uint8_t>(__builtin_popcount(reading.validMask)));
  logger.addSample(reading);

  if (reading.validMask == 0) {
    if (++consecutiveEmptySamples >= 6) {
      scanProbeBus(false);
      consecutiveEmptySamples = 0;
      if (Serial) Serial.println("one_wire_event=reinitialized reason=no_valid_probes");
    }
  } else {
    consecutiveEmptySamples = 0;
  }
}

const char* configWireState() {
  switch (probeConfig.state()) {
    case sauna::ProbeConfigState::Unconfigured:
      return "unconfigured";
    case sauna::ProbeConfigState::Ready:
      return "valid";
    case sauna::ProbeConfigState::Corrupt:
    case sauna::ProbeConfigState::Ambiguous:
    case sauna::ProbeConfigState::StorageUnavailable:
      return "invalid";
  }
  return "invalid";
}

uint32_t storedConfigGeneration() {
  return probeConfig.ready() ? probeConfig.mapping().generation : 0;
}

void syncProbeConfigStatus() {
  logger.setProbeConfigStatus(probeConfig.state(), storedConfigGeneration(),
                              probeConfig.validSlotCount(),
                              probeConfigRestartRequired);
}

void restartConversionSchedule() {
  const uint32_t now = millis();
  startConversion(now);
  nextConversionAt = now + sauna::kSampleIntervalMs;
}

void printConfigError(const char* command, const char* code) {
  Serial.printf("CFG_ERROR command=%s code=%s\n",
                command ? command : "unknown", code ? code : "unknown");
}

bool stagedMappingMatchesDiscovery() {
  if (probeConfig.stagedMask() != 0xFFU || latestDiscovery.overflow ||
      latestDiscovery.busCount != sauna::kProbeCount ||
      latestDiscovery.count != sauna::kProbeCount) {
    return false;
  }
  const sauna::ProbeMapping& staged = probeConfig.stagedMapping();
  for (uint8_t position = 0; position < sauna::kProbeCount; ++position) {
    bool found = false;
    for (uint8_t discovered = 0; discovered < latestDiscovery.count;
         ++discovered) {
      if (memcmp(staged.roms[position], latestDiscovery.probes[discovered].rom,
                 sauna::kProbeRomBytes) == 0) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

void printProbeScan() {
  scanProbeBus(true);
  Serial.printf("CFG_SCAN_BEGIN count=%u bus_count=%u overflow=%u\n",
                latestDiscovery.count, latestDiscovery.busCount,
                latestDiscovery.overflow);
  for (uint8_t index = 0; index < latestDiscovery.count; ++index) {
    const DiscoveredProbe& probe = latestDiscovery.probes[index];
    char rom[17];
    romToText(probe.rom, rom);
    Serial.printf("CFG_SCAN_SENSOR rom=%s temperature_c=", rom);
    if (probe.temperatureValid) {
      Serial.printf("%.2f", probe.temperatureC);
    } else {
      Serial.print("NA");
    }
    Serial.printf(" mapped_position=%u\n", mappedPosition(probe.rom));
  }
  Serial.printf("CFG_SCAN_END count=%u\n", latestDiscovery.count);
  restartConversionSchedule();
}

void printProbeConfiguration() {
  const bool ready = probeConfig.ready();
  const uint8_t count = ready ? sauna::kProbeCount : 0;
  Serial.printf(
      "CFG_GET_BEGIN state=%s generation=%u geometry=%s count=%u "
      "valid_slots=%u detail=%s restart_required=%u\n",
      configWireState(), storedConfigGeneration(),
      ready ? kGeometryName : "none", count, probeConfig.validSlotCount(),
      sauna::probeConfigStateName(probeConfig.state()),
      probeConfigRestartRequired);
  if (ready) {
    const sauna::ProbeMapping& mapping = probeConfig.mapping();
    for (uint8_t index = 0; index < sauna::kProbeCount; ++index) {
      char rom[17];
      romToText(mapping.roms[index], rom);
      Serial.printf("CFG_MAP position=%u relative_height_cm=%d rom=%s\n",
                    index + 1,
                    sauna::probeRelativeHeightCm(mapping.geometryId, index),
                    rom);
    }
  }
  Serial.printf("CFG_GET_END count=%u crc32=%08X\n", count,
                ready ? probeConfig.activeCrc() : 0);
}

bool parseUnsigned(const String& text, uint8_t* value) {
  if (!value || !text.length()) return false;
  uint16_t parsed = 0;
  for (size_t index = 0; index < text.length(); ++index) {
    if (text[index] < '0' || text[index] > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(text[index] - '0');
    if (parsed > (UINT8_MAX - digit) / 10U) return false;
    parsed = parsed * 10U + digit;
  }
  *value = static_cast<uint8_t>(parsed);
  return true;
}

bool parseSetCommand(const String& command, uint8_t* position,
                     uint8_t rom[sauna::kProbeRomBytes]) {
  constexpr char kPrefix[] = "CFG SET position=";
  if (!command.startsWith(kPrefix)) return false;
  const int separator = command.indexOf(" rom=", sizeof(kPrefix) - 1);
  if (separator < 0) return false;
  const String positionText =
      command.substring(sizeof(kPrefix) - 1, separator);
  const String romText = command.substring(separator + 5);
  return parseUnsigned(positionText, position) && parseRomText(romText, rom);
}

bool processSystemCommand(const String& command) {
  if (command == "SYS INFO") {
    const esp_partition_t* running = esp_ota_get_running_partition();
    Serial.printf(
        "SYS_INFO protocol=1 product=sauna_logger firmware=%s commit=%s "
        "partition=%s ota=%s configured=%u active_generation=%u "
        "restart_required=%u commissioning=%u\n",
        SAUNA_FIRMWARE_VERSION, SAUNA_SOURCE_COMMIT, kPartitionLayoutId,
        running ? running->label : "unknown", activeProbeMappingReady,
        activeProbeMappingReady ? activeProbeMapping.generation : 0,
        probeConfigRestartRequired, commissioningLocked);
  } else if (command == "SYS REBOOT") {
    if (logger.active()) {
      Serial.println("SYS_ERROR command=reboot code=active_session");
      return true;
    }
    Serial.println("SYS_REBOOT ok=1");
    Serial.flush();
    delay(100);
    ESP.restart();
  } else if (command.startsWith("SYS ")) {
    Serial.println("SYS_ERROR command=unknown code=unknown_command");
  } else {
    return false;
  }
  return true;
}

bool processConfigCommand(const String& command) {
  if (command == "CFG SCAN") {
    if (logger.active()) {
      printConfigError("scan", "active_session");
    } else if (activeProbeMappingReady && !commissioningLocked) {
      // A fresh bus scan resets the Dallas conversion scheduler. Require an
      // explicit commissioning transaction before disrupting idle sampling.
      printConfigError("scan", "commissioning_required");
    } else {
      printProbeScan();
      if (probeConfig.staging()) commissioningLastActivityAt = millis();
    }
  } else if (command == "CFG GET") {
    printProbeConfiguration();
  } else if (command == "CFG KEEPALIVE") {
    if (logger.active()) {
      printConfigError("keepalive", "active_session");
    } else if (!probeConfig.staging()) {
      printConfigError("keepalive", "not_staging");
    } else {
      commissioningLastActivityAt = millis();
      Serial.println("CFG_KEEPALIVE ok=1");
    }
  } else if (command == "CFG BEGIN geometry=column8_20cm_v1") {
    if (logger.active()) {
      printConfigError("begin", "active_session");
    } else if (probeConfigRestartRequired) {
      printConfigError("begin", "restart_required");
    } else {
      const sauna::ProbeConfigError error = probeConfig.beginStaging();
      if (error != sauna::ProbeConfigError::None) {
        printConfigError("begin", sauna::probeConfigErrorName(error));
      } else {
        commissioningLocked = true;
        logger.setCommissioningMode(true);
        commissioningLastActivityAt = millis();
        Serial.printf("CFG_BEGIN ok=1 geometry=%s\n", kGeometryName);
      }
    }
  } else if (command.startsWith("CFG SET")) {
    uint8_t position = 0;
    uint8_t rom[sauna::kProbeRomBytes]{};
    if (!parseSetCommand(command, &position, rom)) {
      printConfigError("set", "bad_arguments");
    } else {
      const sauna::ProbeConfigError error =
          probeConfig.setStaged(position, rom);
      if (error != sauna::ProbeConfigError::None) {
        printConfigError("set", sauna::probeConfigErrorName(error));
      } else {
        char romText[17];
        romToText(rom, romText);
        commissioningLastActivityAt = millis();
        Serial.printf("CFG_SET ok=1 position=%u rom=%s\n", position,
                      romText);
      }
    }
  } else if (command == "CFG COMMIT") {
    if (logger.active()) {
      printConfigError("commit", "active_session");
    } else if (!probeConfig.staging()) {
      printConfigError("commit", "not_staging");
    } else {
      scanProbeBus(true);
      restartConversionSchedule();
      if (!stagedMappingMatchesDiscovery()) {
        printConfigError("commit", "probe_set_mismatch");
      } else {
        const sauna::ProbeConfigStoreError error = probeConfig.commit();
        if (error != sauna::ProbeConfigStoreError::None) {
          // A failed or unreadable post-write result is ambiguous: the new
          // slot may still have reached flash. Keep logging suspended until a
          // reboot selects one verified generation rather than resuming with
          // a mapping that could change on the next power cycle.
          if (error == sauna::ProbeConfigStoreError::WriteFailed ||
              error == sauna::ProbeConfigStoreError::ReadbackFailed ||
              !probeConfig.ready()) {
            probeConfigRestartRequired = true;
          }
          syncProbeConfigStatus();
          printConfigError("commit", sauna::probeConfigStoreErrorName(error));
        } else {
          probeConfigRestartRequired = true;
          syncProbeConfigStatus();
          Serial.printf(
              "CFG_COMMIT ok=1 generation=%u crc32=%08X "
              "reboot_required=1\n",
              probeConfig.mapping().generation, probeConfig.activeCrc());
        }
      }
    }
  } else if (command == "CFG ABORT") {
    probeConfig.abortStaging();
    if (!probeConfigRestartRequired) {
      commissioningLocked = false;
      logger.setCommissioningMode(false);
    }
    Serial.printf("CFG_ABORT ok=1 restart_required=%u\n",
                  probeConfigRestartRequired);
  } else if (command.startsWith("CFG ")) {
    printConfigError("unknown", "unknown_command");
  } else {
    return false;
  }
  return true;
}

bool processDeviceCommand(const String& command) {
  return processSystemCommand(command) || processConfigCommand(command);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  enableLoopWDT();
  if (Serial)
    Serial.printf("sauna logger %s: Wi-Fi disabled protocol=1\n",
                  SAUNA_FIRMWARE_VERSION);
  printRtcSlowClockDiagnostic();
  configureSensors();
  const bool configStoreAvailable = probeConfig.begin();
  activeProbeMappingReady = probeConfig.ready();
  if (activeProbeMappingReady) activeProbeMapping = probeConfig.mapping();
  logger.setProbeConfiguration(activeProbeMappingReady ? &activeProbeMapping
                                                        : nullptr);
  syncProbeConfigStatus();
  scanProbeBus(false);
  logger.begin();
  if (!configStoreAvailable && Serial)
    Serial.println("logger_event=probe_config_unavailable");
  if (Serial)
    Serial.printf("one_wire_discovered=%u expected=%u configured=%u\n",
                  latestDiscovery.count, sauna::kSensorCount,
                  activeProbeMappingReady);
  restartConversionSchedule();
}

void loop() {
  logger.handleSerial(processDeviceCommand);
  const uint32_t now = millis();
  if (probeConfig.staging() &&
      static_cast<uint32_t>(now - commissioningLastActivityAt) >=
          kCommissioningTimeoutMs) {
    probeConfig.abortStaging();
    Serial.printf(
        "logger_event=commissioning_aborted reason=timeout "
        "logging_suspended=1 restart_required=%u\n",
        probeConfigRestartRequired);
  }
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
