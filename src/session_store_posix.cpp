#include "session_store.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sauna {
namespace {

class PosixStoreFiles final : public StoreFiles {
 public:
  int open(const char* path, bool exclusive) override {
    // In append mode a missing published file is an error, never a new file.
    return ::open(path, O_WRONLY | (exclusive ? O_CREAT | O_EXCL : O_APPEND),
                  0600);
  }
  int64_t write(int fd, const void* data, size_t size) override {
    ssize_t result;
    do {
      result = ::write(fd, data, size);
    } while (result < 0 && errno == EINTR);
    return result;
  }
  bool sync(int fd) override { return ::fsync(fd) == 0; }
  bool close(int fd) override { return ::close(fd) == 0; }
  bool exists(const char* path) override {
    struct stat status {};
    // An I/O error is uncertainty, not permission to replace a destination.
    return ::stat(path, &status) == 0 || errno != ENOENT;
  }
  bool rename(const char* from, const char* to) override {
    // LittleFS commits rename atomically in its metadata transaction.
    return ::rename(from, to) == 0;
  }
};

}  // namespace

StoreFiles& sessionStoreFiles() {
  static PosixStoreFiles files;
  return files;
}

}  // namespace sauna
