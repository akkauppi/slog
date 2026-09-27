#pragma once

#include "session_store.h"

namespace sauna {

// A mounted filesystem does not prove that recording is working. Keep any
// observed recording failure visible until a new initial block is durably
// published. Neither remounting nor an unrelated successful append clears it.
class RecordingHealth {
 public:
  bool ready(bool filesystemMounted) const {
    return filesystemMounted && !failed_;
  }
  bool failed() const { return failed_; }
  void fail() { failed_ = true; }

  StoreError create(StoreFiles& files, const char* staging,
                    const char* published, const StoreChunk* chunks,
                    size_t count) {
    const StoreError result =
        createSession(files, staging, published, chunks, count);
    failed_ = result != StoreError::None;
    return result;
  }

  StoreError append(StoreFiles& files, const char* path,
                    const StoreChunk* chunks, size_t count) {
    const StoreError result = appendSession(files, path, chunks, count);
    if (result != StoreError::None) fail();
    return result;
  }

 private:
  bool failed_ = false;
};

}  // namespace sauna
