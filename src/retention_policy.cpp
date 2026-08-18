#include "retention_policy.h"

#include <limits.h>

namespace sauna {
namespace {

size_t findById(const RetentionSegment* segments, size_t count, uint32_t id) {
  for (size_t index = 0; index < count; ++index) {
    if (segments[index].id == id) return index;
  }
  return count;
}

size_t findChild(const RetentionSegment* segments, size_t count,
                 uint32_t parentId) {
  for (size_t index = 0; index < count; ++index) {
    if (segments[index].continuationOf == parentId) return index;
  }
  return count;
}

bool isProtected(uint32_t id, const uint32_t* protectedIds,
                 size_t protectedCount) {
  for (size_t index = 0; index < protectedCount; ++index) {
    if (protectedIds[index] == id) return true;
  }
  return false;
}

bool validFinishReason(RetentionFinishReason reason) {
  return static_cast<uint8_t>(reason) <=
         static_cast<uint8_t>(RetentionFinishReason::StorageFull);
}

}  // namespace

bool retentionCatalogIsValid(const RetentionSegment* segments, size_t count) {
  if (!segments || !count || count > kMaxRetentionSegments) return false;
  for (size_t index = 0; index < count; ++index) {
    const RetentionSegment& segment = segments[index];
    if (!segment.id || !validFinishReason(segment.finishReason)) return false;
    for (size_t other = index + 1; other < count; ++other) {
      if (segments[other].id == segment.id) return false;
    }
    if (segment.continuationOf) {
      if (segment.continuationOf >= segment.id ||
          findById(segments, count, segment.continuationOf) == count) {
        return false;
      }
    }
    size_t children = 0;
    for (size_t other = 0; other < count; ++other) {
      if (segments[other].continuationOf == segment.id) ++children;
    }
    if (children > 1) return false;
  }
  return true;
}

bool planOldestCompleteRun(const RetentionSegment* segments, size_t count,
                           const uint32_t* protectedIds,
                           size_t protectedCount, RetentionPlan* plan) {
  if (!plan) return false;
  plan->rootId = 0;
  plan->count = 0;
  if (!retentionCatalogIsValid(segments, count) ||
      (protectedCount && !protectedIds)) {
    return false;
  }

  uint32_t selectedRoot = UINT32_MAX;
  for (size_t index = 0; index < count; ++index) {
    if (segments[index].continuationOf) continue;
    bool complete = true;
    bool protectedRun = false;
    size_t chainCount = 0;
    size_t cursor = index;
    while (cursor < count) {
      const RetentionSegment& segment = segments[cursor];
      ++chainCount;
      if (chainCount > count) return false;
      if (segment.finishReason == RetentionFinishReason::Interrupted)
        complete = false;
      if (isProtected(segment.id, protectedIds, protectedCount))
        protectedRun = true;
      cursor = findChild(segments, count, segment.id);
    }
    if (complete && !protectedRun && segments[index].id < selectedRoot)
      selectedRoot = segments[index].id;
  }
  if (selectedRoot == UINT32_MAX) return false;

  size_t cursor = findById(segments, count, selectedRoot);
  while (cursor < count) {
    if (plan->count == kMaxRetentionSegments) {
      plan->rootId = 0;
      plan->count = 0;
      return false;
    }
    plan->sessionIds[plan->count++] = segments[cursor].id;
    cursor = findChild(segments, count, segments[cursor].id);
  }
  for (size_t left = 0, right = plan->count - 1; left < right;
       ++left, --right) {
    const uint32_t swap = plan->sessionIds[left];
    plan->sessionIds[left] = plan->sessionIds[right];
    plan->sessionIds[right] = swap;
  }
  plan->rootId = selectedRoot;
  return true;
}

}  // namespace sauna
