// @vitest-environment node
// Module 5, Part 3: the eval's scoring, without a model. Also checks the
// golden set against the app's own rules, so a wrong expected answer is
// caught here instead of failing Copper for being right.
import { describe, expect, it } from "vitest";
import { GOLDEN_SET } from "@/evals/golden-set";
import {
  type CaseResult,
  casePassed,
  checkRefund,
  judgePrompt,
  markdownReport,
  summarize,
  type TurnOutput,
} from "@/evals/scoring";
import { calculateCost } from "@/lib/copper/assistant/tools";
import { requestRefund } from "@/lib/copper/orders";

const turn = (overrides: Partial<TurnOutput> = {}): TurnOutput => ({
  reply: "Done.",
  status: "done",
  agents: ["Copper"],
  toolCalls: [],
  costUsd: 0.002,
  inputTokens: 1000,
  outputTokens: 100,
  modelCalls: 2,
  latencyMs: 4000,
  ...overrides,
});

const refundCall = (orderId: string, status: string) => ({
  name: "request_refund",
  input: { orderId },
  output: { orderId, status },
});

describe("the golden set", () => {
  it("has unique ids and a good answer for every case", () => {
    const ids = GOLDEN_SET.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    for (const g of GOLDEN_SET)
      expect(g.expectedOutput.goodAnswer).toBeTruthy();
  });

  it("expects the refund decisions the app's rule actually makes ($50 limit)", () => {
    for (const g of GOLDEN_SET) {
      const expected = g.metadata.refund;
      if (!expected || expected.status === "none") continue;
      expect(
        requestRefund(expected.orderId, { limitUsd: 50, refunds: [] }).status,
        g.id,
      ).toBe(expected.status);
    }
  });

  it("expects the total calculate_cost gives for the pricing case", () => {
    const pricing = GOLDEN_SET.find((g) => g.id === "price-two-years")!;
    const { totalUsd } = calculateCost({
      products: ["copper-home"],
      plan: "copper-plus",
      billing: "annual",
      years: 2,
    });
    expect(pricing.expectedOutput.goodAnswer).toContain(`$${totalUsd}`);
  });
});

describe("the refund check (code, not the judge)", () => {
  it("passes when the expected order gets the expected decision", () => {
    expect(
      checkRefund({ orderId: "1001", status: "refunded" }, [
        { name: "get_orders" },
        refundCall("1001", "refunded"),
      ]).passed,
    ).toBe(true);
  });

  it("fails on the wrong decision, a missing request, or a wrong refund", () => {
    const expected = { orderId: "1004", status: "needs_approval" } as const;
    expect(checkRefund(expected, [refundCall("1004", "refunded")]).passed).toBe(
      false,
    );
    expect(checkRefund(expected, []).passed).toBe(false);
    expect(
      checkRefund(expected, [
        refundCall("1004", "needs_approval"),
        refundCall("1001", "refunded"),
      ]).passed,
    ).toBe(false);
  });

  it("expects no refund request at all for 'none'", () => {
    expect(
      checkRefund({ status: "none" }, [{ name: "get_orders" }]).passed,
    ).toBe(true);
    const check = checkRefund({ status: "none" }, [
      refundCall("1001", "refunded"),
    ]);
    expect(check.passed).toBe(false);
    expect(check.comment).toContain("#1001 refunded");
  });
});

describe("passing a case", () => {
  const base = { id: "x", category: "refund" };
  const ok = { passed: true, comment: "" };
  const no = { passed: false, comment: "" };

  it("needs the turn to finish and every check that ran to pass", () => {
    expect(casePassed({ ...base, judge: ok, output: turn() })).toBe(true);
    expect(casePassed({ ...base, judge: ok, refund: ok, output: turn() })).toBe(
      true,
    );
    expect(casePassed({ ...base, judge: no, output: turn() })).toBe(false);
    expect(casePassed({ ...base, judge: ok, refund: no, output: turn() })).toBe(
      false,
    );
    expect(
      casePassed({ ...base, judge: ok, output: turn({ status: "error" }) }),
    ).toBe(false);
    expect(casePassed({ ...base, judge: ok })).toBe(false);
  });
});

describe("the judge's prompt", () => {
  it("gives the judge the message, the good answer, the tool results and the reply", () => {
    const golden = GOLDEN_SET.find((g) => g.id === "refund-under-limit")!;
    const prompt = judgePrompt(
      golden,
      turn({
        reply: "Your $7.99 is on its way back.",
        toolCalls: [refundCall("1001", "refunded")],
      }),
    );
    expect(prompt).toContain(golden.input.message);
    expect(prompt).toContain(golden.expectedOutput.goodAnswer);
    expect(prompt).toContain('request_refund({"orderId":"1001"})');
    expect(prompt).toContain('"status":"refunded"');
    expect(prompt).toContain("Your $7.99 is on its way back.");
  });
});

describe("the report", () => {
  const results: CaseResult[] = [
    {
      id: "a",
      category: "refund",
      passed: true,
      judge: { passed: true, comment: "Good" },
      output: turn({ costUsd: 0.002, latencyMs: 4000 }),
    },
    {
      id: "b",
      category: "pricing",
      passed: false,
      judge: { passed: false, comment: "Wrong | total" },
      output: turn({ costUsd: 0.004, latencyMs: 6000 }),
    },
  ];

  it("adds up pass rate, cost and time", () => {
    const summary = summarize("multi-agent", results);
    expect(summary).toMatchObject({ cases: 2, passed: 1, passRate: 0.5 });
    expect(summary.avgCostUsd).toBeCloseTo(0.003);
    expect(summary.avgLatencyS).toBeCloseTo(5);
  });

  it("shows the scores and each case, with the gate", () => {
    const report = markdownReport(
      [
        {
          summary: summarize("multi-agent", results),
          results,
          url: "https://x",
        },
      ],
      0.75,
    );
    expect(report).toContain("| multi-agent | **50%** | 1/2 |");
    expect(report).toContain("Gate: pass rate must be at least 75%.");
    expect(report).toContain("| b | ❌ | ❌ | — | Wrong \\| total |");
    expect(report).toContain("[run](https://x)");
  });
});
