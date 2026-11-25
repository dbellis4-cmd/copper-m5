// @vitest-environment node
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { propagateAttributes } from "@langfuse/tracing";
import { callText } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  isTracingConfigured,
  LANGFUSE_VARIABLES,
  startTracing,
  stableSpanNames,
  tracingEnvironment,
} from "@/lib/ai/tracing";

// Module 5, Part 2: every AI call is traced for Langfuse. These tests collect
// the traces in memory instead of sending them, so they need no Langfuse keys.

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [
    stableSpanNames,
    new LangfuseSpanProcessor({
      exporter,
      publicKey: "pk-lf-test",
      environment: "test",
      flushAt: 1,
    }),
  ],
});
beforeAll(() => {
  provider.register();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
});
afterAll(() => provider.shutdown());

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  exporter.reset();
  model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Your order ships Monday." }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 1000,
          noCache: 1000,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 200, text: 200, reasoning: undefined },
      },
      warnings: [],
    }),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Langfuse tracing setup", () => {
  it("stays off until all three Langfuse keys are set", () => {
    for (const name of LANGFUSE_VARIABLES) vi.stubEnv(name, "");
    expect(isTracingConfigured()).toBe(false);
    expect(startTracing()).toBe(false);

    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    expect(isTracingConfigured()).toBe(false);

    vi.stubEnv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com");
    expect(isTracingConfigured()).toBe(true);
  });
});

describe("AI calls are traced", () => {
  it("names the call after its feature and records tokens and time", async () => {
    await callText({ module: 4, feature: "refund-agent" }, { prompt: "Hi" });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const agent = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "invoke_agent",
    );
    expect(agent?.attributes["gen_ai.agent.name"]).toBe("refund-agent");
    expect(agent?.attributes["gen_ai.usage.input_tokens"]).toBe(1000);
    expect(agent?.attributes["gen_ai.usage.output_tokens"]).toBe(200);

    const chat = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chat).toBeDefined();
    // Every span has a start and end time, which Langfuse shows as latency.
    expect(chat!.duration[0] + chat!.duration[1]).toBeGreaterThan(0);
  });

  it("puts the model call inside the agent's span, in one trace", async () => {
    await callText({ module: 2, feature: "ask-copper" }, { prompt: "Hi" });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
    const agent = spans.find(
      (s) => s.attributes["gen_ai.agent.name"] === "ask-copper",
    );
    expect(agent).toBeDefined();
  });
});

describe("trace attributes", () => {
  it("files every observation under the trace name, session, tag and environment", async () => {
    await propagateAttributes(
      { traceName: "ask-copper", sessionId: "chat-1", tags: ["home"] },
      () => callText({ module: 2, feature: "ask-copper" }, { prompt: "Hi" }),
    );
    await provider.forceFlush();

    for (const span of exporter.getFinishedSpans())
      expect(span.attributes).toMatchObject({
        "langfuse.trace.name": "ask-copper",
        "session.id": "chat-1",
        "langfuse.trace.tags": ["home"],
        "langfuse.environment": "test",
      });
  });

  it("uses LANGFUSE_TRACING_ENVIRONMENT, then Vercel's environment, then development", () => {
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(tracingEnvironment()).toBe("development");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(tracingEnvironment()).toBe("production");
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "ci");
    expect(tracingEnvironment()).toBe("ci");
  });
});

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<LanguageModelV4StreamPart>
>[0][number];
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 500,
      noCache: 500,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

describe("an Ask Copper turn", () => {
  it("is one trace: the question in, the reply out, one agent section per agent", async () => {
    const steps = [
      calls("transfer_to_refund_agent", { reason: "refund order #1004" }),
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor needs to approve it."),
    ];
    let step = 0;
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(steps[step++] ?? says("")),
      }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { progress } = await askCopper({
      messages: [{ role: "user", content: "Refund order #1004" }],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
      sessionId: "chat-42",
    });
    await finalValue(progress);

    const named = (name: string) =>
      exporter.getFinishedSpans().find((s) => s.name === name);
    await vi.waitFor(async () => {
      await provider.forceFlush();
      expect(named("ask-copper")).toBeDefined();
    });
    const spans = exporter.getFinishedSpans();

    const turn = named("ask-copper")!;
    expect(turn.attributes).toMatchObject({
      "langfuse.observation.input": "Refund order #1004",
      "langfuse.observation.output": "A supervisor needs to approve it.",
      "session.id": "chat-42",
      "langfuse.trace.tags": ["support-page"],
    });
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    // Copper, then the Refund agent after the handoff: each agent appears
    // once, directly under the turn (no duplicate wrapper).
    for (const agent of ["Copper", "Refund agent"]) {
      const agentSpans = spans.filter((s) => s.name === agent);
      expect(agentSpans).toHaveLength(1);
      expect(agentSpans[0].attributes["gen_ai.operation.name"]).toBe(
        "invoke_agent",
      );
      expect(agentSpans[0].parentSpanContext?.spanId).toBe(
        turn.spanContext().spanId,
      );
    }
    // The tool calls are traced too, inside the agent that made them.
    const refundTool = spans.find((s) => s.name.includes("request_refund"));
    expect(refundTool).toBeDefined();

    // Stable, verb-first names: no model name or step number in any name.
    const names = spans.map((s) => s.name);
    expect(names).toContain("generate-response");
    expect(names).toContain("agent-step");
    expect(names.filter((n) => /mock-model-id|step \d/.test(n))).toEqual([]);
  });

  it("marks a failed turn as an error, with the reason", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("You exceeded your current quota");
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { progress } = await askCopper({
      messages: [{ role: "user", content: "Hi" }],
      useTools: true,
    });
    expect((await finalValue(progress)).status).toBe("error");

    const turn = () =>
      exporter.getFinishedSpans().find((s) => s.name === "ask-copper");
    await vi.waitFor(async () => {
      await provider.forceFlush();
      expect(turn()).toBeDefined();
    });
    expect(turn()!.attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(
      String(turn()!.attributes["langfuse.observation.status_message"]),
    ).toContain("You exceeded your current quota");
  });
});
