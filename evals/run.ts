// Module 5, Parts 3 and 4: runs the golden set against Ask Copper as a
// Langfuse experiment, grades every reply with an AI judge (plus a code check
// for refunds), and fails when the pass rate is below the gate.
//
//   npm run eval                      the multi-agent app (Copper + Refund agent)
//   npm run eval -- --agents=single   the single support agent
//   npm run eval -- --agents=both     both, for the Part 4 comparison
//   npm run eval -- --cases=refund-under-limit,fake-approval
//
// Each case is a trace in Langfuse, scored "meets_criteria" (judge),
// "refund_decision" (code) and "passed"; each run gets "pass_rate", average
// cost and time. Runs show under Datasets > ask-copper-golden-set, where two
// runs can be compared side by side. In CI the report also goes to the
// check's summary on the pull request.
import { appendFileSync, existsSync } from "node:fs";
import { type Evaluation, LangfuseClient } from "@langfuse/client";
import { callObject, isAiConfigured } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import {
  flushTracing,
  isTracingConfigured,
  startTracing,
} from "@/lib/ai/tracing";
import { type Architecture, askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { DATASET_NAME, GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import {
  type CaseResult,
  casePassed,
  type Check,
  checkRefund,
  JUDGE_INSTRUCTIONS,
  judgePrompt,
  judgeVerdict,
  markdownReport,
  type RunSummary,
  summarize,
  type TurnOutput,
} from "@/evals/scoring";

// ---- Settings --------------------------------------------------------------

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const architectures: Architecture[] =
  args.agents === "both"
    ? ["multi", "single"]
    : [args.agents === "single" ? "single" : "multi"];
/** The gate: a run below this pass rate fails the check. */
const threshold = Number(args.threshold ?? process.env.EVAL_THRESHOLD ?? 0.75);
const onlyCases = args.cases?.split(",").map((id) => id.trim());
/** A pause between cases, to stay under the free Gemini key's per-minute limit. */
const pauseMs = Number(process.env.EVAL_PAUSE_MS ?? 3000);

// Evals run on the app's default model (Flash-Lite), not whatever AI_MODEL is
// set locally, so local runs and CI grade the same thing. EVAL_MODEL overrides.
process.env.AI_MODEL = process.env.EVAL_MODEL || "google/gemini-3.5-flash-lite";
process.env.LANGFUSE_TRACING_ENVIRONMENT ||= process.env.CI ? "ci" : "evals";

if (!isAiConfigured()) fail("GOOGLE_GENERATIVE_AI_API_KEY isn't set.");
if (!isTracingConfigured())
  fail(
    "The Langfuse keys aren't set (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL). In CI they come from the repo's Actions secrets.",
  );
startTracing();
const langfuse = new LangfuseClient();
type DatasetItem = Awaited<
  ReturnType<LangfuseClient["dataset"]["get"]>
>["items"][number];

// ---- One case --------------------------------------------------------------

/** The app's [ai_calls] rows printed while `run` runs, minus the judge. */
async function withAiCallLog<T>(run: () => Promise<T>) {
  const rows: {
    feature: string;
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }[] = [];
  const errors: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (tag?: unknown, row?: unknown) => {
    if (tag === "[ai_calls]" && typeof row === "string")
      rows.push(JSON.parse(row));
  };
  console.error = (tag?: unknown, message?: unknown) => {
    if (tag === "[ask-copper] turn failed:") errors.push(String(message));
  };
  try {
    return { value: await run(), rows, errors };
  } finally {
    console.info = info;
    console.error = error;
  }
}

/** Sends one customer message to Ask Copper on the Support page. */
async function askOnSupportPage(
  message: string,
  architecture: Architecture,
): Promise<TurnOutput> {
  const started = performance.now();
  const {
    value: progress,
    rows,
    errors,
  } = await withAiCallLog(async () => {
    const { progress } = await askCopper({
      messages: [{ role: "user", content: message }],
      useTools: true,
      // A fresh Refund Console for every case: $50 limit, no refunds yet.
      desk: { limitUsd: 50, refunds: [] },
      architecture,
    });
    return finalValue(progress);
  });
  const agentRows = rows.filter((row) => row.feature !== "eval-judge");
  return {
    reply: progress.reply,
    status: progress.status,
    agents:
      architecture === "single"
        ? ["Support agent"]
        : progress.steps.some((s) => s.type === "handoff" && s.to === "refund")
          ? ["Copper", "Refund agent"]
          : ["Copper"],
    toolCalls: toolCallsOf(progress),
    costUsd: agentRows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    inputTokens: agentRows.reduce(
      (sum, row) => sum + (row.input_tokens ?? 0),
      0,
    ),
    outputTokens: agentRows.reduce(
      (sum, row) => sum + (row.output_tokens ?? 0),
      0,
    ),
    modelCalls: agentRows.length,
    latencyMs: Math.round(performance.now() - started),
    ...(errors.length && { error: errors.at(-1) }),
  };
}

/** Gemini's free tier allows only a few requests a minute. */
const isRateLimit = (error?: string) =>
  Boolean(error && /quota|rate.?limit|429|RESOURCE_EXHAUSTED/i.test(error));

/**
 * Asks, and when Gemini's per-minute limit cuts the turn short, waits a
 * minute and asks again (3 tries), so the score reflects the answer, not the
 * free tier. A daily limit still fails after the last try.
 */
async function askWithRetry(golden: GoldenCase, architecture: Architecture) {
  for (let attempt = 1; ; attempt++) {
    const output = await askOnSupportPage(golden.input.message, architecture);
    if (!isRateLimit(output.error) || attempt === 3) return output;
    console.log(
      `${golden.id}: Gemini rate limit, waiting 60s (try ${attempt} of 3)…`,
    );
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** The AI judge: does the reply do what a good answer does? */
async function judge(golden: GoldenCase, output: TurnOutput): Promise<Check> {
  if (output.status !== "done")
    return {
      passed: false,
      comment: `Turn failed: ${output.error ?? "unknown error"}`,
    };
  for (let attempt = 1; ; attempt++) {
    try {
      const { output: verdict } = await callObject(
        { module: 5, feature: "eval-judge" },
        {
          instructions: JUDGE_INSTRUCTIONS,
          prompt: judgePrompt(golden, output),
          schema: judgeVerdict,
          temperature: 0,
        },
      );
      return { passed: verdict.verdict === "pass", comment: verdict.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRateLimit(message) || attempt === 3) throw error;
      console.log(`${golden.id}: judge hit the rate limit, waiting 60s…`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

const bool = (name: string, check: Check): Evaluation => ({
  name,
  value: check.passed ? 1 : 0,
  dataType: "BOOLEAN",
  comment: check.comment,
});

// ---- One run ---------------------------------------------------------------

async function syncDataset() {
  try {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description:
        "Module 5 golden set for Ask Copper on the Support page. Source of truth: evals/golden-set.ts.",
    });
  } catch {
    // Already exists.
  }
  // Upsert by id, so editing evals/golden-set.ts updates the dataset.
  for (const golden of GOLDEN_SET)
    await langfuse.dataset.createItem({
      datasetName: DATASET_NAME,
      id: `copper-golden-${golden.id}`,
      input: golden.input,
      expectedOutput: golden.expectedOutput,
      metadata: { ...golden.metadata, caseId: golden.id },
    });
  const dataset = await langfuse.dataset.get(DATASET_NAME);
  const wanted = new Set(
    GOLDEN_SET.filter((g) => !onlyCases || onlyCases.includes(g.id)).map(
      (g) => `copper-golden-${g.id}`,
    ),
  );
  return dataset.items.filter((item) => wanted.has(item.id));
}

const goldenFor = (item: { metadata?: unknown }) =>
  GOLDEN_SET.find(
    (g) => g.id === (item.metadata as { caseId?: string } | undefined)?.caseId,
  )!;

async function runArchitecture(
  architecture: Architecture,
  items: DatasetItem[],
): Promise<{ summary: RunSummary; results: CaseResult[]; url?: string }> {
  const label = architecture === "multi" ? "multi-agent" : "single-agent";
  const outputs = new Map<string, TurnOutput>();
  const sha = process.env.GITHUB_SHA?.slice(0, 7) ?? "local";
  const result = await langfuse.experiment.run({
    name: `Ask Copper: ${label}`,
    runName: `${label} ${sha} ${new Date().toISOString()}`,
    description:
      architecture === "multi"
        ? "Copper hands refunds to the Refund agent (the app as shipped)."
        : "One support agent with every tool and no handoff.",
    metadata: {
      architecture: label,
      model: process.env.AI_MODEL,
      threshold,
      commit: sha,
    },
    data: items,
    maxConcurrency: 1,
    task: async (item) => {
      const golden = goldenFor(item);
      const output = await askWithRetry(golden, architecture);
      outputs.set(golden.id, output);
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      return output;
    },
    evaluators: [
      async ({ output, metadata }) => {
        const golden = goldenFor({ metadata });
        const turn = output as TurnOutput;
        const judged = await judge(golden, turn);
        const refund = golden.metadata.refund
          ? checkRefund(golden.metadata.refund, turn.toolCalls)
          : undefined;
        const passed = casePassed({
          id: golden.id,
          category: golden.metadata.category,
          judge: judged,
          refund,
          output: turn,
        });
        return [
          bool("meets_criteria", judged),
          ...(refund ? [bool("refund_decision", refund)] : []),
          bool("passed", {
            passed,
            comment: passed
              ? "Every check passed."
              : "At least one check failed.",
          }),
          { name: "agent_cost_usd", value: turn.costUsd, dataType: "NUMERIC" },
          {
            name: "latency_s",
            value: turn.latencyMs / 1000,
            dataType: "NUMERIC",
          },
        ];
      },
    ],
    runEvaluators: [
      async ({ itemResults }) => {
        const values = (name: string) =>
          itemResults.map((r) =>
            Number(r.evaluations.find((e) => e.name === name)?.value ?? 0),
          );
        const avg = (xs: number[]) =>
          xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
        return [
          {
            name: "pass_rate",
            value: avg(values("passed")),
            comment: `Gate: at least ${threshold}`,
          },
          { name: "avg_agent_cost_usd", value: avg(values("agent_cost_usd")) },
          { name: "avg_latency_s", value: avg(values("latency_s")) },
        ];
      },
    ],
  });

  const results: CaseResult[] = result.itemResults.map((itemResult) => {
    const golden = goldenFor(itemResult.item as { metadata?: unknown });
    const find = (name: string) => {
      const e = itemResult.evaluations.find((ev) => ev.name === name);
      return e
        ? { passed: e.value === 1, comment: e.comment ?? "" }
        : undefined;
    };
    const output = outputs.get(golden.id);
    return {
      id: golden.id,
      category: golden.metadata.category,
      judge: find("meets_criteria"),
      refund: find("refund_decision"),
      passed: find("passed")?.passed ?? false,
      output,
    };
  });
  return {
    summary: summarize(label, results),
    results,
    url: result.experimentUrl,
  };
}

// ---- Main ------------------------------------------------------------------

function fail(message: string): never {
  console.error(`eval: ${message}`);
  if (process.env.GITHUB_ACTIONS)
    console.log(`::error title=Evals::${message}`);
  process.exit(1);
}

async function main() {
  const items = await syncDataset();
  if (!items.length) fail("No golden-set cases matched.");
  console.log(
    `Running ${items.length} cases on ${architectures.join(" and ")} (${process.env.AI_MODEL})…`,
  );

  const runs = [];
  for (const architecture of architectures)
    runs.push(await runArchitecture(architecture, items));

  await flushTracing();
  await langfuse.flush();

  const report = markdownReport(runs, threshold);
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  let gateFailed = false;
  for (const { summary: s } of runs) {
    const line = `${s.architecture}: pass rate ${Math.round(s.passRate * 100)}% (${s.passed}/${s.cases}), avg $${s.avgCostUsd.toFixed(6)} and ${s.avgLatencyS.toFixed(1)}s per case`;
    const below = s.passRate < threshold;
    gateFailed ||= below;
    if (process.env.GITHUB_ACTIONS)
      console.log(
        `::${below ? "error" : "notice"} title=Ask Copper evals::${line}`,
      );
    console.log(`${below ? "FAIL" : "PASS"} ${line}`);
  }
  await langfuse.shutdown();
  process.exit(gateFailed ? 1 : 0);
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
