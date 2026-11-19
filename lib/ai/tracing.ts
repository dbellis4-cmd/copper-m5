// Module 5, Part 2: observability. Every AI call is sent to Langfuse as a
// trace: which agent answered, the tools it used, and each model call with
// its tokens, cost and time. Langfuse is the only tracing tool in this app.
//
// How it works: Langfuse's AI SDK integration (@langfuse/vercel-ai-sdk) turns
// each AI SDK call into Langfuse observations through OpenTelemetry (a
// standard way for code to describe "what happened and how long it took").
// Langfuse's span processor sends them to your Langfuse project. Without the
// three LANGFUSE_* keys nothing is set up, so the app works exactly as before.
// Setup follows https://langfuse.com/integrations/frameworks/vercel-ai-sdk.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export const LANGFUSE_VARIABLES = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export function isTracingConfigured(): boolean {
  return LANGFUSE_VARIABLES.every((name) => Boolean(process.env[name]?.trim()));
}

/**
 * Which environment traces are filed under in Langfuse, so test traces don't
 * mix with real ones: LANGFUSE_TRACING_ENVIRONMENT if set (CI and the evals
 * set it), else Vercel's "production" or "preview", else "development".
 */
export function tracingEnvironment(): string {
  return (
    process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    "development"
  );
}

/** How each agent's feature name shows in Langfuse. */
const AGENT_NAMES: Record<string, string> = {
  "ask-copper": "Copper",
  "refund-agent": "Refund agent",
};

/**
 * The AI SDK names its steps after the model ("chat gemini-3-flash") or a
 * counter ("step 1"). Langfuse's best practice is stable, verb-first names
 * without the model (it's already on each generation), so evaluators and
 * dashboards keep working when the model changes. This renames each step as
 * it starts: each agent after its feature, each model call
 * "generate-response", each loop step "agent-step".
 */
export const stableSpanNames: SpanProcessor = {
  onStart(span: Span) {
    const attributes = span.attributes;
    switch (attributes["gen_ai.operation.name"]) {
      case "invoke_agent": {
        const agent = String(attributes["gen_ai.agent.name"] ?? "agent");
        span.updateName(AGENT_NAMES[agent] ?? agent);
        break;
      }
      case "agent_step":
        span.updateName("agent-step");
        break;
      case "chat":
        span.updateName("generate-response");
        break;
      case "embeddings":
        span.updateName("embed-texts");
        break;
    }
  },
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};

let processor: LangfuseSpanProcessor | undefined;

/**
 * Starts sending AI calls to Langfuse. Called once when the server starts
 * (instrumentation.ts) and by scripts such as the evals. Safe to call twice.
 * Returns false when the Langfuse keys aren't set.
 */
export function startTracing(): boolean {
  if (processor) return true;
  if (!isTracingConfigured()) return false;
  processor = new LangfuseSpanProcessor({ environment: tracingEnvironment() });
  new NodeTracerProvider({
    // Shown in Langfuse as the service that sent the trace.
    resource: resourceFromAttributes({ "service.name": "copper-state-labs" }),
    spanProcessors: [stableSpanNames, processor],
  }).register();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  return true;
}

/**
 * Sends any traces still waiting to Langfuse. Call it when a chat turn or a
 * script ends, so nothing is lost when the server or script stops.
 */
export async function flushTracing(): Promise<void> {
  await processor?.forceFlush();
}
