#include "retention_policy.h"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using sauna::RetentionFinishReason;
using sauna::RetentionPlan;
using sauna::RetentionSegment;

bool expectPlan(const std::string& name,
                const std::vector<RetentionSegment>& segments,
                const std::vector<uint32_t>& protectedIds,
                uint32_t expectedRoot,
                const std::vector<uint32_t>& expectedNewestFirst) {
  RetentionPlan plan{};
  const bool found = sauna::planOldestCompleteRun(
      segments.data(), segments.size(), protectedIds.data(),
      protectedIds.size(), &plan);
  if (!found) {
    std::cerr << name << ": expected a retention candidate\n";
    return false;
  }
  if (plan.rootId != expectedRoot || plan.count != expectedNewestFirst.size()) {
    std::cerr << name << ": unexpected root or segment count\n";
    return false;
  }
  for (size_t index = 0; index < expectedNewestFirst.size(); ++index) {
    if (plan.sessionIds[index] != expectedNewestFirst[index]) {
      std::cerr << name << ": unexpected deletion order at index " << index
                << '\n';
      return false;
    }
  }
  return true;
}

bool expectNoPlan(const std::string& name,
                  const std::vector<RetentionSegment>& segments,
                  const std::vector<uint32_t>& protectedIds = {}) {
  RetentionPlan plan{};
  if (sauna::planOldestCompleteRun(
          segments.data(), segments.size(), protectedIds.data(),
          protectedIds.size(), &plan)) {
    std::cerr << name << ": unexpectedly selected root " << plan.rootId << '\n';
    return false;
  }
  return true;
}

bool completeLinkedRunIsOneCandidate() {
  const std::vector<RetentionSegment> segments = {
      {10, 0, RetentionFinishReason::MaxDuration},
      {11, 10, RetentionFinishReason::MaxDuration},
      {12, 11, RetentionFinishReason::NormalCooling},
  };
  return expectPlan("complete linked run", segments, {}, 10, {12, 11, 10});
}

bool oldestCompleteRunWins() {
  const std::vector<RetentionSegment> segments = {
      {20, 0, RetentionFinishReason::NormalCooling},
      {7, 6, RetentionFinishReason::NormalCooling},
      {6, 0, RetentionFinishReason::MaxDuration},
  };
  return expectPlan("oldest complete run", segments, {}, 6, {7, 6});
}

bool incompleteRunIsNotEligible() {
  const std::vector<RetentionSegment> segments = {
      {1, 0, RetentionFinishReason::MaxDuration},
      {2, 1, RetentionFinishReason::Interrupted},
      {3, 2, RetentionFinishReason::NormalCooling},
      {8, 0, RetentionFinishReason::NormalCooling},
  };
  return expectPlan("skip incomplete run", segments, {}, 8, {8});
}

bool protectedNewestMemberProtectsWholeRun() {
  const std::vector<RetentionSegment> segments = {
      {3, 0, RetentionFinishReason::MaxDuration},
      {4, 3, RetentionFinishReason::MaxDuration},
      {5, 4, RetentionFinishReason::NormalCooling},
      {9, 0, RetentionFinishReason::NormalCooling},
  };
  return expectPlan("protected logical run", segments, {5}, 9, {9});
}

bool everyFinalizedFinishReasonIsEligible() {
  const std::vector<RetentionSegment> segments = {
      {40, 0, RetentionFinishReason::StorageFull},
  };
  return expectPlan("finalized storage-full run", segments, {}, 40, {40});
}

bool finalizedPrefixRemainsEligibleAfterInterruptedDeletion() {
  const std::vector<RetentionSegment> remainingSegments = {
      {50, 0, RetentionFinishReason::MaxDuration},
  };
  return expectPlan("finalized deletion prefix", remainingSegments, {}, 50,
                    {50});
}

bool invalidCatalogsCannotAuthorizeDeletion() {
  const std::vector<RetentionSegment> duplicateIds = {
      {1, 0, RetentionFinishReason::NormalCooling},
      {1, 0, RetentionFinishReason::NormalCooling},
  };
  const std::vector<RetentionSegment> missingPredecessor = {
      {2, 1, RetentionFinishReason::NormalCooling},
  };
  const std::vector<RetentionSegment> branchedChain = {
      {1, 0, RetentionFinishReason::MaxDuration},
      {2, 1, RetentionFinishReason::NormalCooling},
      {3, 1, RetentionFinishReason::NormalCooling},
      {10, 0, RetentionFinishReason::NormalCooling},
  };
  return expectNoPlan("duplicate session IDs", duplicateIds) &&
         expectNoPlan("missing predecessor", missingPredecessor) &&
         expectNoPlan("branched catalog", branchedChain);
}

bool noCompletedRunMeansNoDeletion() {
  const std::vector<RetentionSegment> segments = {
      {30, 0, RetentionFinishReason::MaxDuration},
      {31, 30, RetentionFinishReason::Interrupted},
  };
  return expectNoPlan("no completed run", segments, {31});
}

}  // namespace

int main() {
  if (!completeLinkedRunIsOneCandidate()) return 1;
  if (!oldestCompleteRunWins()) return 1;
  if (!incompleteRunIsNotEligible()) return 1;
  if (!protectedNewestMemberProtectsWholeRun()) return 1;
  if (!everyFinalizedFinishReasonIsEligible()) return 1;
  if (!finalizedPrefixRemainsEligibleAfterInterruptedDeletion()) return 1;
  if (!invalidCatalogsCannotAuthorizeDeletion()) return 1;
  if (!noCompletedRunMeansNoDeletion()) return 1;
  return 0;
}
