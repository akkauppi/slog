#include "session_store.h"
#include "recording_health.h"

#include <algorithm>
#include <cassert>
#include <fstream>
#include <iterator>
#include <map>
#include <string>
#include <vector>

namespace {
using namespace sauna;
struct PowerCut {};

// Models a filesystem that persists file creation independently of contents,
// commits contents on sync/close, and publishes rename atomically. Failure
// checkpoints run AFTER each operation, including after a successful rename.
class MemoryFiles : public StoreFiles {
 public:
  std::map<std::string, std::string> disk{{"/sessions/old", "old committed data"}};
  std::string path;
  std::string pending;
  std::string fail;
  int cut = 0;
  int step = 0;
  bool opened = false;
  size_t writeLimit = 1000;
  void checkpoint() { if (++step == cut) throw PowerCut{}; }
  int open(const char* name, bool exclusive) override {
    if (fail == "open" || (exclusive ? disk.count(name) != 0 : disk.count(name) == 0))
      return -1;
    path = name;
    if (exclusive) disk[path] = "";
    pending = disk[path];
    opened = true;
    checkpoint();
    return 3;
  }
  int64_t write(int fd, const void* bytes, size_t size) override {
    assert(fd == 3 && opened);
    if (fail == "write") return -1;
    if (fail == "zero_write") return 0;
    const size_t count = std::min(writeLimit, size);
    pending.append(static_cast<const char*>(bytes), count);
    checkpoint();
    return count;
  }
  bool sync(int fd) override {
    assert(fd == 3 && opened);
    if (fail == "sync") return false;
    disk[path] = pending;
    checkpoint();
    return true;
  }
  bool close(int fd) override {
    assert(fd == 3 && opened);
    opened = false;
    if (fail == "close") return false;
    // close may itself persist a tail after an earlier explicit sync failure.
    disk[path] = pending;
    checkpoint();
    return true;
  }
  bool exists(const char* name) override { return disk.count(name) != 0; }
  bool rename(const char* from, const char* to) override {
    if (fail == "rename") return false;
    assert(!opened && disk.count(from) && !disk.count(to));
    disk[to] = disk[from];
    disk.erase(from);
    checkpoint();
    return true;
  }
};

const StoreChunk chunks[] = {{"header", 6}, {"block", 5}, {"samples", 7}};
const std::string complete = "headerblocksamples";

void cutsNeverPublishAnIncompleteSession() {
  for (int cut = 1; cut <= 8; ++cut) {
    MemoryFiles fs;
    fs.cut = cut;
    try {
      assert(createSession(fs, "/staging/new", "/sessions/new", chunks, 3) == StoreError::None);
    } catch (const PowerCut&) {}
    assert(fs.disk["/sessions/old"] == "old committed data");
    if (fs.disk.count("/sessions/new")) assert(fs.disk["/sessions/new"] == complete);
  }
}

void failuresAreNotAcknowledged() {
  const std::pair<const char*, StoreError> failures[] = {
      {"open", StoreError::Open}, {"write", StoreError::Write},
      {"zero_write", StoreError::Write}, {"sync", StoreError::Sync},
      {"close", StoreError::Close}, {"rename", StoreError::Publish},
  };
  for (const auto& failure : failures) {
    MemoryFiles fs;
    fs.fail = failure.first;
    assert(createSession(fs, "/staging/new", "/sessions/new", chunks, 3) == failure.second);
    assert(!fs.disk.count("/sessions/new"));
    assert(!fs.opened);
    assert(fs.disk["/sessions/old"] == "old committed data");
  }
  for (const auto& failure : failures) {
    if (std::string(failure.first) == "rename") continue;
    MemoryFiles fs;
    fs.fail = failure.first;
    assert(appendSession(fs, "/sessions/old", chunks, 3) == failure.second);
    assert(fs.disk["/sessions/old"].find("old committed data") == 0);
    assert(!fs.opened);
  }
}

void cutsPreserveTheCommittedAppendPrefix() {
  for (int cut = 1; cut <= 7; ++cut) {
    MemoryFiles fs;
    fs.cut = cut;
    try { appendSession(fs, "/sessions/old", chunks, 3); }
    catch (const PowerCut&) {}
    assert(fs.disk["/sessions/old"].find("old committed data") == 0);
  }
}

void collisionAndShortWrites() {
  MemoryFiles fs;
  assert(createSession(fs, "/staging/new", "/sessions/old", chunks, 3) == StoreError::AlreadyExists);
  assert(!fs.disk.count("/staging/new"));
  fs.disk["/staging/new"] = "preserved orphan";
  assert(createSession(fs, "/staging/new", "/sessions/new", chunks, 3) == StoreError::Open);
  assert(fs.disk["/staging/new"] == "preserved orphan");
  assert(appendSession(fs, "/sessions/missing", chunks, 3) == StoreError::Open);
  assert(!fs.disk.count("/sessions/missing"));
  fs.writeLimit = 2;
  assert(createSession(fs, "/staging/next", "/sessions/next", chunks, 3) == StoreError::None);
  assert(fs.disk["/sessions/next"] == complete);
  assert(!fs.disk.count("/staging/next"));
  assert(appendSession(fs, "/sessions/next", chunks, 3) == StoreError::None);
  assert(fs.disk["/sessions/next"] == complete + complete);
  assert(createSession(fs, "/staging/invalid", "/sessions/invalid", nullptr, 0) == StoreError::InvalidChunks);
}

void persistenceFailuresLatchRecordingReadiness() {
  const char* failures[] = {"open", "write", "zero_write", "sync", "close",
                            "rename"};
  for (const char* failure : failures) {
    MemoryFiles fs;
    RecordingHealth health;
    assert(health.ready(true));
    assert(!health.ready(false));
    fs.fail = failure;
    assert(health.create(fs, "/staging/failed", "/sessions/failed", chunks, 3)
           != StoreError::None);
    assert(health.failed() && !health.ready(true));
    assert(fs.disk["/sessions/old"] == "old committed data");

    // A remount or unrelated successful write is not evidence that a new
    // recording has successfully recovered from the observed failure.
    assert(!health.ready(false));
    fs.fail.clear();
    assert(health.append(fs, "/sessions/old", chunks, 3) == StoreError::None);
    assert(!health.ready(true));
    assert(health.create(fs, "/staging/recovered", "/sessions/recovered",
                         chunks, 3) == StoreError::None);
    assert(health.ready(true) && !health.failed());
    assert(fs.disk["/sessions/recovered"] == complete);

    // Data blocks and footers both use this exact append boundary. Even a
    // close failure following a successful sync must remain a visible fault.
    fs.fail = std::string(failure) == "rename" ? "sync" : failure;
    assert(health.append(fs, "/sessions/recovered", chunks, 3)
           != StoreError::None);
    assert(!health.ready(true));
    assert(fs.disk["/sessions/recovered"].find(complete) == 0);
  }

  MemoryFiles fs;
  RecordingHealth health;
  // Reserve/catalog/encoding failures occur before the store is called.
  health.fail();
  assert(!health.ready(true));
  assert(health.create(fs, "/staging/new", "/sessions/new", chunks, 3)
         == StoreError::None);
  assert(health.ready(true));
  assert(health.create(fs, "/staging/collision", "/sessions/new", chunks, 3)
         == StoreError::AlreadyExists);
  assert(!health.ready(true));
}
}  // namespace

int main(int argc, char** argv) {
  cutsNeverPublishAnIncompleteSession();
  failuresAreNotAcknowledged();
  cutsPreserveTheCommittedAppendPrefix();
  collisionAndShortWrites();
  persistenceFailuresLatchRecordingReadiness();
  // Exercise the production POSIX adapter as well as fault-injected storage.
  assert(argc == 2);
  const std::string staging = std::string(argv[1]) + "/pending.slog";
  const std::string published = std::string(argv[1]) + "/published.slog";
  auto& files = sessionStoreFiles();
  assert(createSession(files, staging.c_str(), published.c_str(), chunks, 3) == StoreError::None);
  assert(!files.exists(staging.c_str()));
  assert(appendSession(files, published.c_str(), chunks, 3) == StoreError::None);
  assert(createSession(files, staging.c_str(), published.c_str(), chunks, 3) == StoreError::AlreadyExists);
  assert(appendSession(files, staging.c_str(), chunks, 3) == StoreError::Open);
  std::ifstream input(published, std::ios::binary);
  const std::string bytes((std::istreambuf_iterator<char>(input)), {});
  assert(bytes == complete + complete);
}
