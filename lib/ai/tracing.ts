// Module 5, Part 2: observability. Every AI call is sent to Langfuse as a
// trace: which agent answered, the tools it used, and each model call with
// its tokens, cost and time. Langfuse is the only tracing tool in this app.
//
// How it works: the AI SDK reports each call through OpenTelemetry (a
// standard way for code to describe "what happened and how long it took").
// Langfuse's span processor collects those reports and sends them to your
// Langfuse project. Without the three LANGFUSE_* keys nothing is set up, so
// the app works exactly as before.
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export const LANGFUSE_VARIABLES = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export function isTracingConfigured(): boolean {
  return LANGFUSE_VARIABLES.every((name) => Boolean(process.env[name]?.trim()));
}

let processor: LangfuseSpanProcessor | undefined;

/**
 * Starts sending AI calls to Langfuse. Called once when the server starts
 * (instrumentation.ts) and by scripts such as the evals. Safe to call twice.
 * Returns false when the Langfuse keys aren't set.
 */
export function startTracing(): boolean {
  if (processor) return true;
  if (!isTracingConfigured()) return false;
  processor = new LangfuseSpanProcessor({
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "development",
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  registerTelemetry(new OpenTelemetry());
  return true;
}

/**
 * Sends any traces still waiting to Langfuse. Call it when a chat turn or a
 * script ends, so nothing is lost when the server or script stops.
 */
export async function flushTracing(): Promise<void> {
  await processor?.forceFlush();
}
