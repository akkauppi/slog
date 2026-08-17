#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sauna {

// This bound is deliberately independent of the on-device directory scanner so
// the policy can be exercised by a small host test. The runtime refuses
// retention, rather than guessing, if the catalog cannot be represented.
constexpr size_t kMaxRetentionSegments = 512;

enum class RetentionFinishReason : uint8_t {
  Interrupted = 0,
  NormalCooling = 1,
  MaxDuration = 2,
  StorageFull = 3,
};

struct RetentionSegment {
  uint32_t id;
  uint32_t continuationOf;
  RetentionFinishReason finishReason;
};

struct RetentionPlan {
  uint32_t rootId;
  size_t count;
  // Deletion order is newest descendant first and the root last. If power is
  // removed between deletions, the files left behind are still a valid prefix.
  uint32_t sessionIds[kMaxRetentionSegments];
};

bool retentionCatalogIsValid(const RetentionSegment* segments, size_t count);

// Select the complete logical run with the smallest root ID. Every segment in
// an eligible run has a valid finalized footer. Invalid, unresolved, or
// branched catalogs are rejected conservatively, and protecting any segment
// protects its entire logical run.
bool planOldestCompleteRun(const RetentionSegment* segments, size_t count,
                           const uint32_t* protectedIds,
                           size_t protectedCount, RetentionPlan* plan);

}  // namespace sauna
