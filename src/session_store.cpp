#include "session_store.h"

namespace sauna {
namespace {

StoreError writeChunks(StoreFiles& files, const char* path, bool exclusive,
                        const StoreChunk* chunks, size_t count) {
  if (!chunks || !count) return StoreError::InvalidChunks;
  for (size_t i = 0; i < count; ++i) {
    if (!chunks[i].data || !chunks[i].size) return StoreError::InvalidChunks;
  }
  const int fd = files.open(path, exclusive);
  if (fd < 0) return StoreError::Open;
  StoreError result = StoreError::None;
  for (size_t i = 0; i < count && result == StoreError::None; ++i) {
    const auto* data = static_cast<const uint8_t*>(chunks[i].data);
    size_t remaining = chunks[i].size;
    while (remaining) {
      const int64_t written = files.write(fd, data, remaining);
      if (written <= 0 || static_cast<uint64_t>(written) > remaining) {
        result = StoreError::Write;
        break;
      }
      data += static_cast<size_t>(written);
      remaining -= static_cast<size_t>(written);
    }
  }
  if (result == StoreError::None && !files.sync(fd)) result = StoreError::Sync;
  // Even after a failed write/sync, release the handle. close can commit an
  // uncertain tail; that does not turn the failed transaction into success.
  if (!files.close(fd) && result == StoreError::None) result = StoreError::Close;
  return result;
}

}  // namespace

StoreError createSession(StoreFiles& files, const char* staging,
                         const char* published, const StoreChunk* chunks,
                         size_t count) {
  if (files.exists(published)) return StoreError::AlreadyExists;
  const StoreError result = writeChunks(files, staging, true, chunks, count);
  if (result != StoreError::None) return result;
  // The firmware has one storage writer. This second check also prevents a
  // pre-existing destination from being replaced by POSIX rename semantics.
  if (files.exists(published)) return StoreError::AlreadyExists;
  return files.rename(staging, published) ? StoreError::None : StoreError::Publish;
}

StoreError appendSession(StoreFiles& files, const char* path,
                         const StoreChunk* chunks, size_t count) {
  return writeChunks(files, path, false, chunks, count);
}

const char* storeErrorName(StoreError error) {
  switch (error) {
    case StoreError::None: return "none";
    case StoreError::InvalidChunks: return "invalid_chunks";
    case StoreError::AlreadyExists: return "already_exists";
    case StoreError::Open: return "open";
    case StoreError::Write: return "write";
    case StoreError::Sync: return "sync";
    case StoreError::Close: return "close";
    case StoreError::Publish: return "publish";
  }
  return "unknown";
}

}  // namespace sauna
