#pragma once

#include <stddef.h>
#include <stdint.h>

#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

using esp_err_t = int32_t;
using nvs_handle_t = uint32_t;

enum nvs_open_mode_t { NVS_READONLY = 0, NVS_READWRITE = 1 };

constexpr esp_err_t ESP_OK = 0;
constexpr esp_err_t ESP_FAIL = -1;
constexpr esp_err_t ESP_ERR_NVS_NOT_FOUND = 0x1102;
constexpr esp_err_t ESP_ERR_NVS_INVALID_LENGTH = 0x110c;

namespace fake_nvs {

inline std::map<std::string, std::vector<uint8_t>> values;
inline bool failOpen = false;
inline std::string failLengthKey;
inline std::string failReadKey;
inline size_t writePrefix = std::numeric_limits<size_t>::max();
inline bool reportCommitFailure = false;

inline void reset() {
  values.clear();
  failOpen = false;
  failLengthKey.clear();
  failReadKey.clear();
  writePrefix = std::numeric_limits<size_t>::max();
  reportCommitFailure = false;
}

}  // namespace fake_nvs

inline esp_err_t nvs_open(const char*, nvs_open_mode_t, nvs_handle_t* handle) {
  if (fake_nvs::failOpen || !handle) return ESP_FAIL;
  *handle = 1;
  return ESP_OK;
}

inline void nvs_close(nvs_handle_t) {}

inline esp_err_t nvs_get_blob(nvs_handle_t handle, const char* key,
                              void* output, size_t* length) {
  if (!handle || !key || !length) return ESP_FAIL;
  if (!output && fake_nvs::failLengthKey == key) return ESP_FAIL;
  if (output && fake_nvs::failReadKey == key) return ESP_FAIL;
  const auto found = fake_nvs::values.find(key);
  if (found == fake_nvs::values.end()) return ESP_ERR_NVS_NOT_FOUND;
  if (!output) {
    *length = found->second.size();
    return ESP_OK;
  }
  if (*length < found->second.size()) {
    *length = found->second.size();
    return ESP_ERR_NVS_INVALID_LENGTH;
  }
  std::memcpy(output, found->second.data(), found->second.size());
  *length = found->second.size();
  return ESP_OK;
}

inline esp_err_t nvs_set_blob(nvs_handle_t handle, const char* key,
                              const void* input, size_t length) {
  if (!handle || !key || !input || !length) return ESP_FAIL;
  const size_t stored =
      fake_nvs::writePrefix < length ? fake_nvs::writePrefix : length;
  const auto* bytes = static_cast<const uint8_t*>(input);
  fake_nvs::values[key] = std::vector<uint8_t>(bytes, bytes + stored);
  return stored == length ? ESP_OK : ESP_FAIL;
}

inline esp_err_t nvs_commit(nvs_handle_t handle) {
  if (!handle || fake_nvs::reportCommitFailure) return ESP_FAIL;
  return ESP_OK;
}
