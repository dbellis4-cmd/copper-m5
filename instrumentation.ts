// Next.js runs register() once when the server starts. Module 5, Part 2:
// it turns on Langfuse tracing (lib/ai/tracing.ts) when the keys are set.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("@/lib/ai/tracing");
    startTracing();
  }
}
