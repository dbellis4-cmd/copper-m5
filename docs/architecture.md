# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved …" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent
→ `request_refund` → the app compares the amount with the limit → refunded,
or waiting on the Refund Console → Approve or Reject → console note → Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5, Part 1: tests in CI

**Summary:** `.github/workflows/ci.yml` runs lint, the type check, the tests
and the build on Linux, macOS and Windows for every pull request and for each
push to `main`. A ruleset on `main` in the student's repo only lets changes in
through a pull request whose checks all pass.

**Secrets:** `GOOGLE_GENERATIVE_AI_API_KEY` is an Actions secret. Only the
Linux job gets it, so the live Gemini test (`tests/ai.integration.test.ts`)
costs one request per run; on macOS and Windows it skips.
`tests/ci-workflow.test.ts` fails if a step or the key goes missing.

## Module 5, Part 2: observability (Langfuse)

**Summary:** Every AI call is traced in Langfuse, set up with the Langfuse
agent skill and Langfuse's AI SDK 7 guide. `instrumentation.ts` calls
`startTracing()` (`lib/ai/tracing.ts`) when the server starts; it registers
Langfuse's AI SDK integration (`@langfuse/vercel-ai-sdk`) and span processor
(`@langfuse/otel`). Without `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL` nothing is set up. `@ai-sdk/otel` is pinned to the
version that matches `ai`, or the two clash.

**What a trace shows** (following Langfuse's "what does a good trace look
like" guide):

- One trace per Ask Copper turn, named `ask-copper`, with the customer's
  question as input and the reply as output (plain text, readable in the
  tracing table). Status and the agents that spoke are metadata; a failed
  turn is marked `ERROR`.
- One session per conversation: the chat panel makes a `sessionId` for each
  conversation (with and without tools), so the Sessions view replays it.
- One `agent` observation per agent that spoke, directly under the turn:
  "Copper", then "Refund agent" after a handoff. These are the AI SDK's own
  agent observations (no duplicate wrapper). Each holds its `agent-step`s,
  each step a `generate-response` generation (model, tokens, cost, time,
  thinking) and the tool calls it requested.
- Stable names: `stableSpanNames` in `lib/ai/tracing.ts` renames the AI SDK's
  steps as they start, so no name contains the model ("chat gemini-...") or a
  counter ("step 1"). The model is still on each generation. The service is
  named `copper-state-labs`.
- A tag for where the chat ran (`home` or `support-page`).
- The environment: `LANGFUSE_TRACING_ENVIRONMENT` if set, else Vercel's
  `VERCEL_ENV`, else `development`, so test traces stay out of production.
- `lib/ai/call.ts` names every call after its feature (`telemetry.functionId`),
  so calls outside the chat are labeled too. Each turn flushes its trace.

**Tests:** `tests/tracing.test.ts` runs spans through Langfuse's processor into
memory (no keys needed) and checks the feature name, tokens and time, the
trace attributes, the environment, and a full Copper to Refund agent turn.

## Module 5, Parts 3 and 4: evals with an AI judge, single vs multi agent

**Summary:** `npm run eval` (`evals/run.ts`) runs the golden set
(`evals/golden-set.ts`, 8 Support-page cases) against Ask Copper as a Langfuse
experiment on the dataset `ask-copper-golden-set`, which it creates and keeps
in sync (items are upserted by id). Each reply is graded two ways:

- **AI judge** (`meets_criteria`): Gemini, through `callObject` in
  `lib/ai/call.ts` (feature `eval-judge`), reads the customer's message, what
  a good answer does, the tools the agent called with their results, and the
  reply, then gives a reason and pass or fail.
- **Refund check** (`refund_decision`, code): for refund cases, the app's
  `request_refund` result must be the expected status for the expected order,
  and nothing else may be refunded.

A case `passed` when the turn finished and every check passed. Each run also
gets `pass_rate`, `avg_agent_cost_usd` and `avg_latency_s` (the agent's own
model calls, not the judge's). Evals use the default model (Gemini 3.5
Flash-Lite, or `EVAL_MODEL`), a fresh $50-limit Refund Console per case, one
case at a time with a pause, and a retry after a minute when Gemini's
per-minute limit cuts a turn short. The scoring is plain functions in
`evals/scoring.ts`, tested in `tests/evals.test.ts`, which also checks the
golden set against the app's own refund rule and prices.

**CI:** the `evals` job in `.github/workflows/ci.yml` runs `npm run eval` on
every pull request after the checks pass, with `GOOGLE_GENERATIVE_AI_API_KEY`,
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from Actions secrets. The
report (pass rate, cost and time, and each case with the judge's reason) goes
to the check's summary, with a notice on the check, and the job fails below
the gate (pass rate 75%, `--threshold` or `EVAL_THRESHOLD`). The `main`
ruleset requires it, so a pull request whose evals fail can't merge.

**Part 4, single agent:** `askCopper({ architecture: "single" })` runs one
"Support agent" (`SUPPORT_AGENT_INSTRUCTIONS`, feature `support-agent`) with
Copper's tools plus `get_orders` and `request_refund`, and no handoff. The
default, `"multi"`, is the app as shipped. `npm run eval -- --agents=both`
runs the golden set on both; compare the two runs in Langfuse under Datasets >
`ask-copper-golden-set`.
