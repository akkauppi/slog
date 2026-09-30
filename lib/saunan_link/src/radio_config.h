#pragma once
#include <array>
#include <stddef.h>
#include <stdint.h>
namespace sauna_link {
enum class RadioMode : uint8_t { Off = 0, EspNow = 1 }; // Wi-Fi gets a new schema.
constexpr size_t kRadioConfigBytes = 60;
struct RadioConfig {
  RadioMode mode = RadioMode::Off;
  uint8_t channel = 0;
  uint64_t sourceId = 0;
  std::array<uint8_t, 6> peer{};
  std::array<uint8_t, 16> pmk{};
  std::array<uint8_t, 16> lmk{};
};
bool validConfig(const RadioConfig& config);
bool encodeConfig(const RadioConfig& config, uint8_t* bytes, size_t size);
bool decodeConfig(const uint8_t* bytes, size_t size, RadioConfig& config);
bool decodeHex(const char* text, size_t length, uint8_t* bytes, size_t size);
}  // namespace sauna_link
