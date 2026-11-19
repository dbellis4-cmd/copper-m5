// @vitest-environment node
import { expect, it } from "vitest";

// Demo only (Module 5, Part 1): a test that fails on purpose, to show that a
// failing check blocks the merge into main. This pull request is never merged.
it("fails on purpose to show branch protection", () => {
  expect(1 + 1).toBe(3);
});
