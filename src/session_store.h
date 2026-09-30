#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sauna {

struct StoreChunk {
  const void* data;
  size_t size;
};

// This boundary exposes durability errors hidden by Arduino File::flush/close.
// An adapter must never overwrite an existing file when exclusive is true.
class StoreFiles {
 public:
  virtual ~StoreFiles() = default;
  virtual int open(const char* path, bool exclusive) = 0;
  virtual int64_t write(int descriptor, const void* data, size_t size) = 0;
  virtual bool sync(int descriptor) = 0;
  virtual bool close(int descriptor) = 0;
  virtual bool exists(const char* path) = 0;
  virtual bool rename(const char* from, const char* to) = 0;
};

enum class StoreError : uint8_t {
  None, InvalidChunks, AlreadyExists, Open, Write, Sync, Close, Publish,
};

// Failure never authorizes a retry on the same uncertain tail. Staged files
// remain outside the session catalog for preservation and diagnosis.
StoreError createSession(StoreFiles& files, const char* staging,
                         const char* published, const StoreChunk* chunks,
                         size_t count);
StoreError appendSession(StoreFiles& files, const char* path,
                         const StoreChunk* chunks, size_t count);
const char* storeErrorName(StoreError error);
StoreFiles& sessionStoreFiles();

}  // namespace sauna
