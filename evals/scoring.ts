// Module 5, Part 3: how each eval case is scored, as plain functions so they
// can be tested without a model. evals/run.ts wires them to Ask Copper, the
// AI judge and Langfuse.
import { z } from "zod";
import type { ExpectedRefund, GoldenCase } from "@/evals/golden-set";

export type ToolCall = { name: string; input?: unknown; output?: unknown };

/** What one Ask Copper turn produced, as the eval sees it. */
export type TurnOutput = {
  reply: string;
  status: "done" | "error" | "working";
  /** Agents that spoke, as named in Langfuse. */
  agents: string[];
  toolCalls: ToolCall[];
  /** Summed from the app's ai_calls log for this turn (judge not included). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  latencyMs: number;
  /** Why the turn failed, if it did. */
  error?: string;
};

export type Check = { passed: boolean; comment: string };

type RefundOutput = { status?: string; orderId?: string; amountUsd?: number };

const refundCalls = (toolCalls: ToolCall[]) =>
  toolCalls
    .filter((call) => call.name === "request_refund")
    .map((call) => (call.output ?? {}) as RefundOutput);

/**
 * The refund decision, checked in code (not by the judge): did the app reach
 * the expected status for the expected order, and nothing else?
 */
export function checkRefund(
  expected: ExpectedRefund,
  toolCalls: ToolCall[],
): Check {
  const calls = refundCalls(toolCalls);
  if (expected.status === "none") {
    return calls.length === 0
      ? { passed: true, comment: "No refund was requested, as expected." }
      : {
          passed: false,
          comment: `Expected no refund request, got: ${calls
            .map((c) => `#${c.orderId} ${c.status}`)
            .join(", ")}.`,
        };
  }
  const hit = calls.some(
    (c) => c.orderId === expected.orderId && c.status === expected.status,
  );
  const wrongRefund = calls.find(
    (c) => c.status === "refunded" && c.orderId !== expected.orderId,
  );
  if (hit && !wrongRefund)
    return {
      passed: true,
      comment: `Order #${expected.orderId}: ${expected.status}, as expected.`,
    };
  const got = calls.length
    ? calls.map((c) => `#${c.orderId} ${c.status}`).join(", ")
    : "no refund request";
  return {
    passed: false,
    comment: `Expected #${expected.orderId} ${expected.status}, got ${got}.`,
  };
}

export const judgeVerdict = z.object({
  reason: z
    .string()
    .describe("One or two sentences: what the reply did or missed."),
  verdict: z.enum(["pass", "fail"]),
});

export const JUDGE_INSTRUCTIONS = `You grade replies from Copper State Labs' customer support chatbot.
You get the customer's message, a description of what a good answer does, the chatbot's reply, and the tools it called with their results (the facts it had).
Pass the reply only if it does everything the description asks and nothing it rules out. Use the tool results to check facts like amounts, totals and refund outcomes; the app's tools are always right.
Judge only what the reply says to the customer, not its style or length. A reply that refuses, errors or says "Sorry, something went wrong" fails unless the description asks for a refusal.
Give the reason first, then the verdict.`;

/** The judge's prompt for one case. */
export function judgePrompt(golden: GoldenCase, output: TurnOutput): string {
  const tools = output.toolCalls.length
    ? output.toolCalls
        .map(
          (call) =>
            `- ${call.name}(${JSON.stringify(call.input ?? {})}) -> ${truncate(
              JSON.stringify(call.output ?? null),
              1200,
            )}`,
        )
        .join("\n")
    : "(none)";
  return `Customer's message:
${golden.input.message}

What a good answer does:
${golden.expectedOutput.goodAnswer}

Tools the chatbot called, with their results:
${tools}

The chatbot's reply:
${output.reply || "(empty)"}`;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One case's result once scored. */
export type CaseResult = {
  id: string;
  category: string;
  judge?: Check;
  refund?: Check;
  /** Passed only if every check that ran passed, and the turn didn't fail. */
  passed: boolean;
  output?: TurnOutput;
};

export function casePassed(result: Omit<CaseResult, "passed">): boolean {
  if (!result.output || result.output.status !== "done") return false;
  if (!result.judge?.passed) return false;
  return result.refund ? result.refund.passed : true;
}

export type RunSummary = {
  architecture: string;
  cases: number;
  passed: number;
  passRate: number;
  /** Average per case, for the agent's own model calls (not the judge). */
  avgCostUsd: number;
  avgLatencyS: number;
  avgModelCalls: number;
  totalCostUsd: number;
};

export function summarize(
  architecture: string,
  results: CaseResult[],
): RunSummary {
  const outputs = results.flatMap((r) => (r.output ? [r.output] : []));
  const avg = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const passed = results.filter((r) => r.passed).length;
  const totalCostUsd = outputs.reduce((sum, o) => sum + o.costUsd, 0);
  return {
    architecture,
    cases: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    avgCostUsd: avg(outputs.map((o) => o.costUsd)),
    avgLatencyS: avg(outputs.map((o) => o.latencyMs / 1000)),
    avgModelCalls: avg(outputs.map((o) => o.modelCalls)),
    totalCostUsd,
  };
}

const usd = (value: number) => `$${value.toFixed(6)}`;
const pct = (value: number) => `${Math.round(value * 100)}%`;
const mark = (check?: Check) => (check ? (check.passed ? "✅" : "❌") : "—");

/** The report shown in the CI check's summary and printed locally. */
export function markdownReport(
  runs: { summary: RunSummary; results: CaseResult[]; url?: string }[],
  threshold: number,
): string {
  const lines = ["## Ask Copper evals (AI judge)", ""];
  lines.push(
    "| Agents | Pass rate | Passed | Avg cost / case | Avg time / case | Avg AI calls | Langfuse |",
    "|---|---|---|---|---|---|---|",
  );
  for (const { summary: s, url } of runs)
    lines.push(
      `| ${s.architecture} | **${pct(s.passRate)}** | ${s.passed}/${s.cases} | ${usd(s.avgCostUsd)} | ${s.avgLatencyS.toFixed(1)}s | ${s.avgModelCalls.toFixed(1)} | ${url ? `[run](${url})` : "—"} |`,
    );
  lines.push("", `Gate: pass rate must be at least ${pct(threshold)}.`, "");
  for (const { summary, results } of runs) {
    lines.push(
      `### ${summary.architecture}`,
      "",
      "| Case | Pass | Judge | Refund check | Judge's reason |",
      "|---|---|---|---|---|",
    );
    for (const r of results)
      lines.push(
        `| ${r.id} | ${r.passed ? "✅" : "❌"} | ${mark(r.judge)} | ${mark(r.refund)} | ${escapeCell(
          r.output?.error
            ? `Turn failed: ${r.output.error}`
            : (r.judge?.comment ?? "Not judged"),
        )} |`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

function escapeCell(text: string) {
  return truncate(text.replace(/\|/g, "\\|").replace(/\n+/g, " "), 300);
}
