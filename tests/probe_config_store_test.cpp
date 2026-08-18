#include "probe_config_store.h"

#include <nvs.h>

#include <cstring>
#include <iostream>
#include <limits>
#include <string>

namespace {

bool check(bool condition, const std::string& message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

void fillRom(uint8_t rom[sauna::kProbeRomBytes], uint8_t identity) {
  std::memset(rom, 0, sauna::kProbeRomBytes);
  rom[0] = 0x28;
  rom[1] = identity;
  rom[3] = static_cast<uint8_t>(identity ^ 0xA5);
  rom[6] = static_cast<uint8_t>(identity + 41);
  rom[7] = sauna::probeRomCrc8(rom, sauna::kProbeRomBytes - 1);
}

bool stageMapping(sauna::ProbeConfigStore* store, uint8_t seed) {
  if (store->beginStaging() != sauna::ProbeConfigError::None) return false;
  for (uint8_t position = 1; position <= sauna::kProbeCount; ++position) {
    uint8_t rom[sauna::kProbeRomBytes]{};
    fillRom(rom, static_cast<uint8_t>(seed + position));
    if (store->setStaged(position, rom) != sauna::ProbeConfigError::None)
      return false;
  }
  return true;
}

bool firstAndAlternatingCommits() {
  fake_nvs::reset();
  sauna::ProbeConfigStore store;
  if (!check(store.begin(), "empty NVS did not open") ||
      !check(store.state() == sauna::ProbeConfigState::Unconfigured,
             "empty NVS was not unconfigured") ||
      !check(stageMapping(&store, 1), "first mapping did not stage") ||
      !check(store.commit() == sauna::ProbeConfigStoreError::None,
             "first mapping did not commit"))
    return false;
  if (!check(store.ready() && store.mapping().generation == 1 &&
                 store.validSlotCount() == 1 && store.activeCrc() != 0 &&
                 !store.staging(),
             "first commit state is wrong"))
    return false;
  if (!check(stageMapping(&store, 30), "second mapping did not stage") ||
      !check(store.commit() == sauna::ProbeConfigStoreError::None,
             "second mapping did not commit") ||
      !check(store.mapping().generation == 2 &&
                 store.validSlotCount() == 2,
             "second commit did not select the other slot"))
    return false;
  if (!check(stageMapping(&store, 60), "third mapping did not stage") ||
      !check(store.commit() == sauna::ProbeConfigStoreError::None,
             "third mapping did not commit"))
    return false;
  return check(store.mapping().generation == 3 &&
                   store.validSlotCount() == 2,
               "third commit did not alternate back to the old slot");
}

bool everyTornStoreWriteKeepsOldMapping() {
  for (size_t prefix = 0; prefix < sizeof(sauna::ProbeConfigRecordV1);
       ++prefix) {
    fake_nvs::reset();
    sauna::ProbeConfigStore store;
    if (!store.begin() || !stageMapping(&store, 1) ||
        store.commit() != sauna::ProbeConfigStoreError::None ||
        !stageMapping(&store, 30))
      return check(false, "fixture setup failed");
    fake_nvs::writePrefix = prefix;
    if (!check(store.commit() == sauna::ProbeConfigStoreError::WriteFailed,
               "torn write did not report failure at prefix " +
                   std::to_string(prefix)))
      return false;
    if (!check(store.ready() && store.mapping().generation == 1 &&
                   store.staging(),
               "torn write displaced old mapping at prefix " +
                   std::to_string(prefix)))
      return false;
  }
  return true;
}

bool committedDespiteReportedFailureIsRecovered() {
  fake_nvs::reset();
  sauna::ProbeConfigStore store;
  if (!store.begin() || !stageMapping(&store, 1) ||
      store.commit() != sauna::ProbeConfigStoreError::None ||
      !stageMapping(&store, 30))
    return check(false, "recovery fixture setup failed");
  fake_nvs::reportCommitFailure = true;
  if (!check(store.commit() == sauna::ProbeConfigStoreError::None,
             "complete write with lost status was not recovered"))
    return false;
  return check(store.ready() && store.mapping().generation == 2 &&
                   !store.staging(),
               "recovered commit did not activate new mapping");
}

bool validationAndStorageFailuresAreConservative() {
  fake_nvs::reset();
  sauna::ProbeConfigStore store;
  if (!store.begin()) return check(false, "failure fixture did not open");
  if (!check(store.commit() == sauna::ProbeConfigStoreError::InvalidMapping &&
                 store.lastConfigError() == sauna::ProbeConfigError::NotStaging,
             "commit outside staging was accepted"))
    return false;
  store.beginStaging();
  uint8_t rom[sauna::kProbeRomBytes]{};
  fillRom(rom, 1);
  store.setStaged(1, rom);
  if (!check(store.commit() == sauna::ProbeConfigStoreError::InvalidMapping &&
                 store.lastConfigError() == sauna::ProbeConfigError::Incomplete,
             "incomplete mapping was accepted"))
    return false;
  store.abortStaging();
  fake_nvs::failOpen = true;
  return check(!store.begin() &&
                   store.state() ==
                       sauna::ProbeConfigState::StorageUnavailable &&
                   store.lastStoreError() ==
                       sauna::ProbeConfigStoreError::OpenFailed,
               "NVS open failure was not surfaced");
}

bool readbackFailureDoesNotClaimCommit() {
  fake_nvs::reset();
  sauna::ProbeConfigStore store;
  if (!store.begin() || !stageMapping(&store, 1) ||
      store.commit() != sauna::ProbeConfigStoreError::None ||
      !stageMapping(&store, 30))
    return check(false, "readback fixture setup failed");
  fake_nvs::failReadKey = "slot_b";
  return check(store.commit() == sauna::ProbeConfigStoreError::ReadbackFailed &&
                   store.staging() && !store.ready() &&
                   store.state() ==
                       sauna::ProbeConfigState::StorageUnavailable,
               "written slot readback failure claimed a commit");
}

bool unreadableNewerSlotFailsClosedAtBoot() {
  fake_nvs::reset();
  sauna::ProbeConfigStore writer;
  if (!writer.begin() || !stageMapping(&writer, 1) ||
      writer.commit() != sauna::ProbeConfigStoreError::None ||
      !stageMapping(&writer, 30) ||
      writer.commit() != sauna::ProbeConfigStoreError::None) {
    return check(false, "unreadable-slot fixture setup failed");
  }
  fake_nvs::failReadKey = "slot_b";
  sauna::ProbeConfigStore reader;
  return check(!reader.begin() && !reader.ready() &&
                   reader.state() ==
                       sauna::ProbeConfigState::StorageUnavailable &&
                   reader.lastStoreError() ==
                       sauna::ProbeConfigStoreError::ReadFailed,
               "boot selected an older mapping while the newer slot was unreadable");
}

bool unreadableSlotLengthFailsClosedAtBoot() {
  fake_nvs::reset();
  sauna::ProbeConfigStore writer;
  if (!writer.begin() || !stageMapping(&writer, 1) ||
      writer.commit() != sauna::ProbeConfigStoreError::None ||
      !stageMapping(&writer, 30) ||
      writer.commit() != sauna::ProbeConfigStoreError::None) {
    return check(false, "unreadable-length fixture setup failed");
  }
  fake_nvs::failLengthKey = "slot_b";
  sauna::ProbeConfigStore reader;
  return check(!reader.begin() && !reader.ready() &&
                   reader.state() ==
                       sauna::ProbeConfigState::StorageUnavailable &&
                   reader.lastStoreError() ==
                       sauna::ProbeConfigStoreError::ReadFailed,
               "slot length I/O failure was mistaken for a missing slot");
}

}  // namespace

int main() {
  if (!firstAndAlternatingCommits()) return 1;
  if (!everyTornStoreWriteKeepsOldMapping()) return 1;
  if (!committedDespiteReportedFailureIsRecovered()) return 1;
  if (!validationAndStorageFailuresAreConservative()) return 1;
  if (!readbackFailureDoesNotClaimCommit()) return 1;
  if (!unreadableNewerSlotFailsClosedAtBoot()) return 1;
  if (!unreadableSlotLengthFailsClosedAtBoot()) return 1;
  return 0;
}
