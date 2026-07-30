/**
 * subagent.ts — spawn_subagent: delegate a bounded task to a scoped child agent.
 *
 * The context-isolation lever, orchestrator-worker style. A wide search or a
 * self-contained chunk of work can cost dozens of tool rounds whose intermediate
 * output would bloat the main agent's context. spawn_subagent runs that work in a
 * CHILD session — its own transcript, its own read ledger, its own step budget — and
 * returns only the child's final, distilled summary. The lead agent gets the answer
 * without the mess, and can spawn SEVERAL read-only workers in ONE message to fan out
 * in parallel (the engine runs concurrency-safe calls together).
 *
 * It reuses the engine's own `respond()` loop on a forked session (via `ctx.forkChild`,
 * injected by the engine), so a sub-agent is a full agent, not a lesser one. Recursion
 * is capped by `subagentDepth` so a sub-agent can't spawn its own sub-agents. The child
 * inherits the parent's approval channel and Sentinel gate, so its edits are gated too;
 * `read_only` restricts it to searching/reading for safe research tasks — and ONLY a
 * read-only worker is concurrency-safe (an editing worker runs alone, in order, so
 * parallel edits can't race). A process-wide semaphore bounds how many run at once.
 */
import { randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "./types.js";
import type { EngineEvent } from "../dynamo/engine.js";

const MAX_SUBAGENT_DEPTH = 1;
/** Default step budget for a worker; the caller can scale it with `max_steps`. */
const SUBAGENT_BUDGET = envInt("MINDWEAVE_SUBAGENT_BUDGET", 20);
/** Ceiling on `max_steps` so one worker can't run away. */
const MAX_SUBAGENT_STEPS = envInt("MINDWEAVE_SUBAGENT_MAX_STEPS", 60);
/** How many workers may run concurrently, process-wide. */
const SUBAGENT_CONCURRENCY = envInt("MINDWEAVE_SUBAGENT_CONCURRENCY", 5);

/**
 * A bounded gate so a wide fan-out queues instead of launching a swarm of agents at
 * once. Hand-off release (the freed slot goes straight to the next waiter) keeps the
 * live count at or below the limit even under interleaved arrivals.
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over; active is unchanged, so we never exceed limit
    else this.active--;
  }
}

const gate = new Semaphore(SUBAGENT_CONCURRENCY);

export const spawnSubagent: Tool = {
  name: "spawn_subagent",
  readOnly: false,
  // A read-only worker changes nothing and is safe to fan out in parallel; an editing
  // worker must run alone (serial lane) so concurrent edits can't race. This is what
  // lets the model emit several read-only spawn_subagent calls in one message and have
  // them run concurrently.
  isConcurrencySafe: (args) => args.read_only === true,
  description:
    "Delegate a focused, self-contained subtask to a child agent that has its own context, then get back " +
    "just its result — the way to keep a wide search, an inventory, or a bounded chunk of work from filling " +
    "your context with intermediate steps (e.g. \"find and list every call site of authFetch\"). The child " +
    "does NOT see this conversation and cannot ask the user questions, so write a COMPLETE, standalone task: " +
    "a clear objective, its boundaries (what NOT to touch), and — via output_format — the exact shape of the " +
    "result you want back. Set read_only:true for research/inventory that must not change files.\n" +
    "PARALLEL: emit SEVERAL read-only spawn_subagent calls in ONE message to run them at once and fan out over " +
    "independent areas; give each a distinct slice so they don't duplicate work. Scale effort to the task: a " +
    "lookup needs 1 worker, a comparison 2–4, and only genuinely independent areas warrant more. Sub-agents " +
    "cost many more tokens than doing it inline, and most editing is sequential — delegate for independent " +
    "READ/discovery, not to parallelize edits.\n" +
    "BRIEF IT WELL: write to the child like a competent colleague who just walked in — it can't see this " +
    "conversation. Never hand off the thinking: don't write \"based on your findings, fix the bug\" — do the " +
    "synthesis yourself and give specifics (file paths, line numbers, exactly what to change). Terse " +
    "command-style prompts produce shallow, generic work.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description:
          "A complete, standalone objective for the child, including any context and scope boundaries it needs " +
          "(it cannot see your conversation).",
      },
      read_only: {
        type: "boolean",
        description:
          "When true, the child may only read/search — no edits or commands — AND it runs in parallel with other " +
          "read-only workers spawned in the same message. Default false (runs alone). Use true for research/inventory.",
      },
      output_format: {
        type: "string",
        description:
          "The exact shape the result should come back in (e.g. \"a bullet list of `file:line — what's there`\"). " +
          "Strongly recommended — it keeps the report tight and directly usable.",
      },
      max_steps: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SUBAGENT_STEPS,
        description: `Tool-round budget for the child (default ${SUBAGENT_BUDGET}). Scale it up for deeper tasks, down for quick lookups.`,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) return fail("`task` is required — describe the subtask for the child agent.");

    const depth = ctx.subagentDepth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return fail("a sub-agent cannot spawn another sub-agent — do this part of the work directly.");
    }
    if (!ctx.forkChild) {
      return fail("sub-agents aren't available in this context.");
    }

    const outputFormat = typeof args.output_format === "string" ? args.output_format.trim() : "";
    const framedTask = outputFormat
      ? `${task}\n\nReport your result in EXACTLY this format:\n${outputFormat}`
      : task;
    const budget = clampSteps(args.max_steps) ?? SUBAGENT_BUDGET;
    const readOnly = args.read_only === true;

    const child = ctx.forkChild(framedTask, { readOnly });
    // Dynamic import: the static registry ← engine edge would otherwise cycle. By the
    // time execute() runs, both modules are fully loaded, so this is safe.
    const { respond } = await import("../dynamo/engine.js");

    // A short id for THIS worker. Every event it emits carries it, so the UI keeps each
    // worker's nested rail distinct even when several fan out in parallel.
    const agentId = randomUUID().slice(0, 8);
    const taskLabel = task.replace(/\s+/g, " ").trim().slice(0, 100);
    ctx.emitEvent?.({ type: "subagent", phase: "start", id: agentId, task: taskLabel, readOnly });

    let reply: string;
    try {
      // Bounded: a wide fan-out queues here rather than launching every worker at once.
      reply = await gate.run(() =>
        respond(child, {
          signal: ctx.abortSignal,
          maxSteps: budget,
          // Surface the child's activity, not its chatter: its usage counts toward the
          // meter, and each of its tool calls is forwarded UP tagged with this worker's
          // id so the UI nests them in the worker's rail (its prose/reasoning stays
          // muted — only the final distilled report crosses back, as the tool result).
          onEvent: (e: EngineEvent) => {
            if (e.type === "usage") ctx.reportUsage?.(e);
            else if (e.type === "tool") ctx.emitEvent?.({ ...e, agent: agentId });
          },
        }),
      );
    } catch (error) {
      ctx.emitEvent?.({ type: "subagent", phase: "end", id: agentId, summary: "failed", error: true });
      return fail(`the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const steps = child.transcript.filter((e) => e.role === "assistant").length;
    const scope = readOnly ? " · read-only" : "";
    const stepLabel = `${steps} step${steps === 1 ? "" : "s"}${scope}`;
    ctx.emitEvent?.({ type: "subagent", phase: "end", id: agentId, summary: stepLabel, error: false });
    return {
      output: reply,
      summary: `subagent · ${stepLabel}`,
    };
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

/** A clamped positive step budget from the model's `max_steps`, or undefined. */
export function clampSteps(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(MAX_SUBAGENT_STEPS, n);
}

/** A positive integer from an env var, or `fallback`. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
