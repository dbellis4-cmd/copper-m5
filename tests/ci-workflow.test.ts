// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Module 5, Part 1: the checks in GitHub Actions are what branch protection on
// main waits for. If someone edits the workflow and drops a step, this fails.
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("CI workflow", () => {
  it("runs on every pull request and on pushes to main", () => {
    expect(workflow).toMatch(/^\s{2}pull_request:/m);
    expect(workflow).toMatch(/push:\s*\n\s*branches: \[main\]/);
  });

  it("runs lint, typecheck, tests and the build", () => {
    for (const step of [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]) {
      expect(workflow).toContain(`- run: ${step}`);
    }
  });

  it("checks on Linux, macOS and Windows", () => {
    expect(workflow).toContain(
      "os: [ubuntu-latest, macos-latest, windows-latest]",
    );
  });

  it("gives the tests the Gemini key from Actions secrets, on Linux only", () => {
    expect(workflow).toContain(
      "GOOGLE_GENERATIVE_AI_API_KEY: ${{ matrix.os == 'ubuntu-latest' && secrets.GOOGLE_GENERATIVE_AI_API_KEY || '' }}",
    );
  });
});

describe("CI evals (Module 5, Part 3)", () => {
  const evals = workflow.slice(workflow.indexOf("\n  evals:"));

  it("runs the golden-set eval on pull requests, after the checks pass", () => {
    expect(evals).toContain("if: github.event_name == 'pull_request'");
    expect(evals).toContain("needs: check");
    expect(evals).toContain("- run: npm run eval");
  });

  it("gets the Gemini and Langfuse keys from Actions secrets", () => {
    for (const name of [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
    ])
      expect(evals).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(evals).toContain("LANGFUSE_TRACING_ENVIRONMENT: ci");
  });
});
