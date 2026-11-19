// @vitest-environment node
import { OpenTelemetry } from "@ai-sdk/otel";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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
import { callText } from "@/lib/ai/call";
import {
  isTracingConfigured,
  LANGFUSE_VARIABLES,
  startTracing,
} from "@/lib/ai/tracing";

// Module 5, Part 2: every AI call is traced for Langfuse. These tests collect
// the traces in memory instead of sending them, so they need no Langfuse keys.

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => {
  provider.register();
  registerTelemetry(new OpenTelemetry());
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
