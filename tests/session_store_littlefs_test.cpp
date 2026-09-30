#include "session_store.h"
#include "lfs.h"

#include <cassert>
#include <cstring>
#include <vector>

namespace {
using namespace sauna;
constexpr size_t kBlockSize = 4096;
std::vector<uint8_t> medium(128 * kBlockSize, 255);
int mutations = 0;
int cutAfter = 0;
bool powerLost = false;

int readBlock(const lfs_config* c, lfs_block_t block, lfs_off_t offset,
              void* data, lfs_size_t size) {
  if (powerLost) return LFS_ERR_IO;
  memcpy(data, medium.data() + block * c->block_size + offset, size);
  return 0;
}
int mutationFinished() {
  if (++mutations == cutAfter) powerLost = true;
  return powerLost ? LFS_ERR_IO : 0;
}
int programBlock(const lfs_config* c, lfs_block_t block, lfs_off_t offset,
                 const void* data, lfs_size_t size) {
  if (powerLost) return LFS_ERR_IO;
  auto* target = medium.data() + block * c->block_size + offset;
  const auto* source = static_cast<const uint8_t*>(data);
  for (lfs_size_t i = 0; i < size; ++i) target[i] &= source[i];
  return mutationFinished();
}
int eraseBlock(const lfs_config* c, lfs_block_t block) {
  if (powerLost) return LFS_ERR_IO;
  memset(medium.data() + block * c->block_size, 255, c->block_size);
  return mutationFinished();
}
int syncBlock(const lfs_config*) { return powerLost ? LFS_ERR_IO : 0; }

lfs_config configuration() {
  lfs_config c{};
  c.read = readBlock; c.prog = programBlock;
  c.erase = eraseBlock; c.sync = syncBlock;
  c.read_size = 16; c.prog_size = 16;
  c.block_size = kBlockSize; c.block_count = 128;
  c.block_cycles = 500; c.cache_size = 256; c.lookahead_size = 16;
  return c;
}

class LittleFiles : public StoreFiles {
 public:
  lfs_t fs{};
  lfs_file_t file{};
  int open(const char* path, bool exclusive) override {
    return lfs_file_open(&fs, &file, path, LFS_O_WRONLY |
        (exclusive ? LFS_O_CREAT | LFS_O_EXCL : LFS_O_APPEND)) == 0 ? 3 : -1;
  }
  int64_t write(int, const void* data, size_t size) override {
    return lfs_file_write(&fs, &file, data, size);
  }
  bool sync(int) override { return lfs_file_sync(&fs, &file) == 0; }
  bool close(int) override { return lfs_file_close(&fs, &file) == 0; }
  bool exists(const char* path) override {
    lfs_info info{};
    return lfs_stat(&fs, path, &info) != LFS_ERR_NOENT;
  }
  bool rename(const char* from, const char* to) override {
    return lfs_rename(&fs, from, to) == 0;
  }
};

std::vector<uint8_t> readFile(lfs_t* fs, const char* path) {
  lfs_info info{};
  assert(lfs_stat(fs, path, &info) == 0);
  std::vector<uint8_t> bytes(info.size);
  lfs_file_t file{};
  assert(lfs_file_open(fs, &file, path, LFS_O_RDONLY) == 0);
  assert(lfs_file_read(fs, &file, bytes.data(), bytes.size()) == static_cast<lfs_ssize_t>(bytes.size()));
  assert(lfs_file_close(fs, &file) == 0);
  return bytes;
}
}  // namespace

int main() {
  const auto config = configuration();
  LittleFiles initial;
  assert(lfs_format(&initial.fs, &config) == 0);
  assert(lfs_mount(&initial.fs, &config) == 0);
  assert(lfs_mkdir(&initial.fs, "/sessions") == 0);
  assert(lfs_mkdir(&initial.fs, "/staging") == 0);
  const std::vector<uint8_t> oldBytes(4000, 0x51);
  const StoreChunk oldChunk{oldBytes.data(), oldBytes.size()};
  assert(createSession(initial, "/staging/old", "/sessions/old", &oldChunk, 1) == StoreError::None);
  assert(lfs_unmount(&initial.fs) == 0);
  const auto snapshot = medium;
  std::vector<uint8_t> content(1658, 0x37);  // V2 header + full pretrigger block.
  const StoreChunk chunks[] = {{content.data(), 142}, {content.data() + 142, 16},
                               {content.data() + 158, 1500}};
  // Establish the number of physical program/erase boundaries for each path,
  // then fail immediately after every one and remount the surviving medium.
  for (bool append : {false, true}) {
    int boundaries = 0;
    for (int cut = 0; cut <= boundaries; ++cut) {
      medium = snapshot;
      mutations = 0; cutAfter = cut; powerLost = false;
      LittleFiles writer;
      assert(lfs_mount(&writer.fs, &config) == 0);
      const StoreError result = append
          ? appendSession(writer, "/sessions/old", chunks, 3)
          : createSession(writer, "/staging/new", "/sessions/new", chunks, 3);
      if (cut == 0) {
        assert(result == StoreError::None);
        boundaries = mutations;
        assert(boundaries > 0);
      } else {
        assert(result != StoreError::None);
      }
      lfs_unmount(&writer.fs);  // Frees RAM; cannot write with powerLost set.
      powerLost = false; cutAfter = 0;
      LittleFiles reboot;
      assert(lfs_mount(&reboot.fs, &config) == 0);
      const auto previous = readFile(&reboot.fs, "/sessions/old");
      assert(previous.size() >= oldBytes.size());
      assert(memcmp(previous.data(), oldBytes.data(), oldBytes.size()) == 0);
      if (!append) {
        assert(previous == oldBytes);
        lfs_info info{};
        if (lfs_stat(&reboot.fs, "/sessions/new", &info) == 0)
          assert(readFile(&reboot.fs, "/sessions/new") == content);
      }
      assert(lfs_unmount(&reboot.fs) == 0);
    }
  }
}
