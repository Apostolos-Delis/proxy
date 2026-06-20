import { graphql } from "./gql";
import type { HarnessCompatibilityMatrixQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";

const HarnessCompatibilityMatrixDocument = graphql(`
  query HarnessCompatibilityMatrix {
    harnessCompatibilityMatrix {
      profileId
      displayName
      harness
      surface
      transport
      targetDialect
      effectiveDialect
      translatedFrom
      translatedTo
      status
      support
      nativeSupport
      translatedSupport
      statefulFeatures
      unsupportedStatefulFeatures
      reasonCodes
      testedFixtureCount
      lastSmokeStatus {
        status
        checkedAt
        detail
      }
    }
  }
`);

export type HarnessCompatibilityRow = HarnessCompatibilityMatrixQuery["harnessCompatibilityMatrix"][number];

export async function fetchHarnessCompatibilityMatrix() {
  return (await gqlFetch(HarnessCompatibilityMatrixDocument)).harnessCompatibilityMatrix;
}
