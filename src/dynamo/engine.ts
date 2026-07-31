/**
 * dynamo — the engine.
 *
 * Takes a live session and produces Mindweave's next reply, running tools along the
 * way. The loop is intentionally tiny: ask the model → if it wants tools, run
 * them and feed the results back → repeat → when it answers with no tool call,
 * that's the reply. The model does the reasoning; the loop stays out of the way.
 *
 * The engine owns the TRANSCRIPT (it appends every user/assistant/tool turn to
 * `session.transcript`) and keeps it healthy with the compaction cascade. It is
 * pure of the filesystem: it never reads or writes session files (the CLI
 * persists). The one disk touch is re-reading project files, which goes through
 * the read-only tool exactly like any other tool call — so this whole function
 * can later move to a server unchanged, with tools executing on the client.
 */
import { activeDriver, ensureDriver } from "../drivers/registry.js";
import type { ChatMessage, ModelRequest, StopReason, StreamResult, Usage, WireToolCall } from "../drivers/types.js";
import { summarizeTask, taskLimitReason, type TaskLimits } from "./pricing.js";
import { mutationNeedsVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, VERIFY_NUDGE } from "./verify.js";
import { GUARD_OPTIONS, GUARD_REFUSAL, guardQuestion, interpretGuardChoice } from "./guard.js";
import { findTool, toolSchemas } from "../tools/registry.js";
import { commandShellLabel } from "../tools/runCommand.js";
import { isInteractiveServerCommand } from "../tools/backgroundShells.js";
import { basePrompt } from "./prompt.js";
import { relative } from "node:path";
import { relativize, resolvePath, rootLabel } from "../tools/paths.js";
import { todoListText } from "../tools/todo.js";
import { renderRules, renderSkillCatalog } from "../governor/index.js";
import type { Session, Entry, ToolCallRecord } from "../memory/types.js";
import { forkSession } from "../memory/session.js";
import { buildWorkingSet } from "../memory/workingSet.js";
import {
  KEEP_LAST_N,
  KEEP_LAST_N_BOUNDARY,
  SUMMARY_REQUEST,
  SUMMARY_SYSTEM_PROMPT,
  estimateEntriesTokens,
  formatTranscriptForSummary,
  isContinuation,
  microcompact,
  spliceSummary,
} from "../memory/compaction.js";
import { autoCompactThreshold, microCompactThreshold } from "./contextWindow.js";
import { renderSessionMemory, shouldUpdateSessionMemory, updateSessionMemory } from "../memory/sessionMemory.js";

/** Stop retrying autocompact after this many consecutive failures in a session, so a
 *  transcript that's irrecoverably over the limit can't hammer the summarizer each turn
 *  (a circuit-breaker for runaway retry loops, which can otherwise pile up thousands of doomed retries). */
const MAX_COMPACT_FAILURES = 3;

// The static base (identity, output/formatting, tone, tool mechanics, safety,
// task hygiene, and how to use cross-session memory) comes from basePrompt in
// prompt.ts. Here we wrap it with the per-session, per-turn context: the
// governor (rules/forbidden/skills), the project snapshot, MINDWEAVE.md, the memory
// index, the ranked code map, the task list, and the multi-root workspace. The
// line we hold is the thin-prompt boundary: rich on what the harness owns, but
// we still do NOT teach engineering judgment (how to debug, how to write code) —
// that is the model's job.
export function staticSystemPrompt(
  projectContext: string,
  projectMemory: string,
  memoryDir: string,
  memoryIndex: string,
  governance: GovernancePrompt,
  workspace: string,
): string {
  let prompt = basePrompt(commandShellLabel());

  if (workspace) {
    prompt += `

This session spans more than one root folder. Each file is addressed as \`label/path\`; search tools cover every root unless you pass a specific \`path\`. The roots are:
<workspace>
${workspace}
</workspace>`;
  }

  // NOTE: the user's standing rules are deliberately NOT rendered here. They live
  // in the volatile tail (volatileContext) instead — rebuilt every turn at the
  // boundary where attention is strongest, so a long session can't bury them in the
  // middle of a huge cached prefix. Rules are the one governance layer that depends
  // purely on the model reading and obeying (forbidden is enforced mechanically;
  // skills are a reference catalog), so they alone get the salience boost. Keeping
  // them out of the prefix also stops a mid-session `remember_rule` from busting it.
  if (governance.forbidden) {
    prompt += `

You are FORBIDDEN from modifying these paths — never write, edit, or run a command that changes them. The tools also enforce this and will refuse, but do not even try:
<forbidden>
${governance.forbidden}
</forbidden>`;
  }
  if (governance.forbiddenCommands) {
    prompt += `

You are FORBIDDEN from running these commands (or any command that contains one) — run_command will refuse them and only the user can lift that. Do not attempt them or a workaround:
<forbidden_commands>
${governance.forbiddenCommands}
</forbidden_commands>`;
  }
  if (governance.skills) {
    prompt += `

You have project skills available — named procedures you can run. To run one, call use_skill with its name; its full steps are loaded then (you only see the summary here). Use one when its description fits the task:
<available_skills>
${governance.skills}
</available_skills>`;
  }

  if (projectContext) {
    prompt += `

The following describes the project and machine you're working in, captured at the start of this session (a snapshot — use tools for anything current or deeper):
${projectContext}`;
  }
  if (projectMemory) {
    prompt += `

The project provides this context in its MINDWEAVE.md — treat it as background facts about this codebase:
<project_memory>
${projectMemory}
</project_memory>`;
  }
  if (memoryDir) {
    prompt += `

Your cross-session memory for this project lives in \`${memoryDir}\` (read or grep the topic files there for the full text of any entry). Its index:
<memory_index>
${memoryIndex || "(empty — nothing has been saved to memory yet)"}
</memory_index>`;
  }

  return prompt;
}

/**
 * The volatile per-turn context, rendered at the TAIL of the request (outside the
 * cacheable prefix): the ranked code map and the live task list. These change
 * across steps/turns, so keeping them out of the system prompt is what lets the
 * system + conversation prefix stay byte-stable and be served from the provider's
 * prompt cache. Returns "" when there's nothing to add.
 */
export function volatileContext(
  rules: string,
  relevantMap: string,
  todoList: string,
  workingFiles: string,
  planMode: boolean,
  sessionMemory: string,
): string {
  const parts: string[] = [];
  // Standing rules FIRST in the volatile tail. They're rebuilt every turn here (not
  // in the cached prefix), so a long conversation can never bury them — and they sit
  // at the top of the freshest context the model reads before it acts. Binding by
  // design: they override the model's own defaults.
  if (rules) {
    parts.push(
      "The user's standing rules for this project. They are BINDING — follow them exactly, and let them " +
        "override your own defaults and habits. Do not violate them or work around them:\n" +
        `<rules>\n${rules}\n</rules>`,
    );
  }
  // Plan mode (Architect) lives in the VOLATILE tail, not the cached prefix, so
  // toggling it with shift-tab never invalidates the cached system prompt.
  if (planMode) {
    parts.push(
      "You are in PLAN MODE (Architect). Research the codebase and think the change through, then present a clear, " +
        "step-by-step plan for the user to approve — do NOT modify files, run commands, or take any action. Editing " +
        "tools are withheld this turn; if you need one, say so in the plan. Once the user approves and switches modes, " +
        "you'll carry it out.",
    );
  }
  // The maintained session state — first in the volatile tail so the model reads
  // "here's where we are" before the map/task list. Survives compaction.
  const memBlock = renderSessionMemory(sessionMemory);
  if (memBlock) parts.push(memBlock);
  if (relevantMap) {
    parts.push(
      "Code most relevant to your current focus (from the code map; use the code-map tools for more):\n" +
        `<relevant_code>\n${relevantMap}\n</relevant_code>`,
    );
  }
  if (todoList) {
    parts.push(
      "Your current task list (maintain it with todo_write; [x] done, [~] in progress, [ ] pending):\n" +
        `<task_list>\n${todoList}\n</task_list>`,
    );
  }
  // Working files LAST — the freshest, most task-critical content sits at the very end
  // of the request (the boundary), where attention is strongest (lost-in-the-middle).
  if (workingFiles) {
    parts.push(`<working_files>\n${workingFiles}\n</working_files>`);
  }
  return parts.join("\n\n");
}

// The governor's three prompt blocks, pre-rendered to strings ("" when empty so
// the block is omitted). Built fresh each turn from the session's governance.
interface GovernancePrompt {
  rules: string;
  forbidden: string;
  forbiddenCommands: string;
  skills: string;
}

function governancePrompt(session: Session): GovernancePrompt {
  const g = session.governance;
  // The working set: project-relative POSIX paths the model has touched this
  // session. Glob-scoped rules fire only when one of these matches their globs.
  const root = g.forbidden.root;
  const workingSet = [...session.toolContext.reads.keys()].map((abs) =>
    relative(root, abs).split("\\").join("/"),
  );
  return {
    rules: renderRules(g.rules, workingSet),
    forbidden: g.forbidden.patterns.map((p) => `- ${p}`).join("\n"),
    forbiddenCommands: (g.forbidden.commands ?? []).map((c) => `- ${c}`).join("\n"),
    skills: renderSkillCatalog(g.skills, workingSet),
  };
}

// The tiny, budgeted ranked map injected each turn (the "auto-map" half of the
// relevance feed). Personalized to the files recently read. A pure in-memory
// chassis query — no I/O, no model call — so the engine stays filesystem-pure.
const AUTO_MAP_LIMIT = 12;

async function relevantMapText(session: Session): Promise<string> {
  const chassis = session.toolContext.chassis;
  if (!chassis || !chassis.status().ready) return "";
  const focus = [...session.toolContext.reads.keys()].slice(-5);
  const ranked = await chassis.relevant(focus, AUTO_MAP_LIMIT);
  if (ranked.length === 0) return "";
  return ranked
    .map((r) => {
      const s = r.symbol;
      const where = `${relativize(session.toolContext, s.file)}:${s.line}`;
      // A short doc conveys intent so the always-on map is more than names.
      const doc = s.doc ? ` — ${s.doc}` : "";
      return `- ${s.name} (${s.kind}) ${where}${doc}`;
    })
    .join("\n");
}

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** A boolean env flag. Default ON unless explicitly set to 0/false/off/no. */
function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

/** A non-negative number from the environment, or the fallback. */
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Per-task cost/time ceilings. OFF (0) by default — opt-in via env, so there are
 *  no surprise pauses; a runaway is one env var away from being capped. */
function taskLimits(): TaskLimits {
  return {
    maxUsd: envNum("MINDWEAVE_MAX_TASK_USD", 0),
    maxSeconds: envNum("MINDWEAVE_MAX_TASK_SECONDS", 0),
  };
}

// Max model turns (tool rounds) in one reply. A generous ceiling: real multi-file
// work — a feature across a dozen files, a refactor — should finish in one go, so
// this is a circuit-breaker against a runaway loop, NOT a work limit. When it is
// hit the loop pauses LOSSLESSLY (the transcript, task list, and working set are
// intact) and hands the decision to continue back to the user, so it can never
// silently burn tokens. Env-overridable for power users.
const STEP_BUDGET = envInt("MINDWEAVE_STEP_BUDGET", 50);
// Verification gate: when the model edits files then tries to finish without
// running any check, nudge it once to verify. On by default; MINDWEAVE_VERIFY_GATE=0
// disables it. See verify.ts for the (pure, tested) fact detectors.
const VERIFY_GATE = envFlag("MINDWEAVE_VERIFY_GATE", true);
// Background-poll allowance: how many still-running background-shell polls the model
// may make in one turn before the loop stops it. A finished shell notifies the model
// automatically, so polling is redundant; one poll is allowed (a legitimate "grab the
// current tail" when the user asks), the wait-loop after that is stopped deterministically.
const BG_POLL_ALLOWANCE = envInt("MINDWEAVE_BG_POLL_LIMIT", 1);
// How many times in a row the model may fire a step that fails the SAME way before we
// stop it. 3 is the threshold: repeated identical failures past that are a stuck loop,
// not progress. Env-overridable for tuning.
const REPEAT_FAIL_LIMIT = envInt("MINDWEAVE_REPEAT_FAIL_LIMIT", 3);

/**
 * A live event from a turn, for the streaming UI. The model's reasoning and answer
 * arrive as `reasoning`/`text` deltas; each tool the model runs bookends with a
 * `tool` start (name + parsed args, before it runs) and end (summary, after) keyed
 * by the call `id`; `usage` reports the turn's token count once the answer lands.
 * Out-of-band notices (compaction) still go through `onActivity`, not here.
 */
export type EngineEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  // `agent` (a sub-agent id) tags a tool event that came from a spawned worker, so the
  // UI can nest it under that worker's row instead of the main stream. Absent on the
  // lead agent's own calls.
  | { type: "tool"; phase: "start"; id: string; name: string; args: Record<string, unknown>; agent?: string }
  | { type: "tool"; phase: "end"; id: string; name: string; summary: string; error: boolean; detail?: string; agent?: string }
  // A spawned sub-agent's lifecycle: `start` when it's dispatched (with its task +
  // read-only flag), `end` when it reports back. Between them, its own tool events
  // arrive tagged with this `id`, so the UI can render a live nested rail per worker.
  | { type: "subagent"; phase: "start"; id: string; task: string; readOnly: boolean }
  | { type: "subagent"; phase: "end"; id: string; summary: string; error: boolean }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number };

export interface RespondOptions {
  /** Called once per tool run (and on compaction) with a short line for the live
   *  UI. `opts.error` marks a failed tool so the UI can flag it; `opts.context`
   *  marks a context-housekeeping line (compaction) so the UI sets it apart. */
  onActivity?: (line: string, opts?: { error?: boolean; context?: boolean }) => void;
  /** Called for every live event of the turn (deltas, tool lifecycle, usage). The
   *  streaming UI renders from these; omit it for a non-interactive caller. */
  onEvent?: (event: EngineEvent) => void;
  /** Aborts the in-flight model call, kills a running command, and stops the loop at
   *  the next boundary (the user pressing Esc). run_command listens to the same signal. */
  signal?: AbortSignal;
  /** Persist the session NOW — called after every transcript step (assistant message,
   *  tool results, final reply) so a hard crash / PC shutdown loses at most the current
   *  in-flight step, not the whole turn. Best-effort; awaited so the write lands before
   *  the next model call. Omit for callers that don't persist (e.g. sub-agents). */
  persist?: () => Promise<unknown> | void;
  /** Cap on tool rounds for THIS run, overriding the default step budget. Used to
   *  give a spawned sub-agent a smaller budget than the main agent. */
  maxSteps?: number;
}

/** True if an error is an AbortError (the model call was cancelled). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Record and return a clean interrupted reply (well-formed transcript). */
function interrupted(session: Session): string {
  const msg = "(interrupted)";
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Map our stored tool calls to the provider's wire shape. */
function toWire(calls: ToolCallRecord[]): WireToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.arguments },
  }));
}

/** The labeled root list for the prompt — "" for an ordinary single-root session. */
function workspaceText(session: Session): string {
  const roots = session.toolContext.roots ?? [];
  if (roots.length <= 1) return "";
  return roots.map((r) => `- ${rootLabel(roots, r)}  →  ${r}`).join("\n");
}

/**
 * Build the provider-agnostic request from a session. The split is deliberate and
 * is what makes prompt caching work on every model (see ModelRequest):
 *   - `system`   — the STABLE system prompt (identity, tools guidance, governance,
 *                  project facts). Same bytes every step → cached prefix.
 *   - `messages` — the conversation, append-only, plus any one-shot background-shell
 *                  notes for this turn (transient — never stored, so they can't
 *                  re-inject).
 *   - `context`  — the VOLATILE per-turn map + task list, rendered at the tail so it
 *                  never invalidates the cached prefix.
 */
function buildRequest(
  session: Session,
  relevantMap: string,
  workingFiles: string,
  bgEvents: string[],
  tools: ReturnType<typeof toolSchemas>,
): ModelRequest {
  const messages: ChatMessage[] = [];
  for (const e of session.transcript) {
    if (e.role === "user" || e.role === "summary") {
      messages.push({ role: "user", content: e.content });
    } else if (e.role === "assistant") {
      messages.push({
        role: "assistant",
        content: e.content,
        ...(e.toolCalls && e.toolCalls.length > 0 ? { tool_calls: toWire(e.toolCalls) } : {}),
      });
    } else {
      messages.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content });
    }
  }
  for (const note of bgEvents) messages.push({ role: "user", content: note });

  // Compute the governance blocks once: the prefix uses forbidden/skills, the
  // volatile tail uses the rules (moved there for salience — see volatileContext).
  const gov = governancePrompt(session);
  return {
    system: staticSystemPrompt(
      session.projectContext,
      session.projectMemory,
      session.memoryDir,
      session.memoryIndex,
      gov,
      workspaceText(session),
    ),
    messages,
    context: volatileContext(
      gov.rules,
      relevantMap,
      todoListText(session.toolContext),
      workingFiles,
      session.toolContext.planMode ?? false,
      session.sessionMemory ?? "",
    ),
    tools,
    model: session.modelConfig,
  };
}

/**
 * Collect one-shot notes for background shells that finished since the last turn.
 * Drained ONCE here (the manager marks them reported), so the model is told exactly
 * once — never the re-injecting-forever leak that plagues other agents.
 */
async function backgroundEventNotes(session: Session): Promise<string[]> {
  const mgr = session.toolContext.backgroundShells;
  if (!mgr) return [];
  const done = await mgr.drainCompleted();
  return done.map(({ info, tail }) => {
    const status = info.status === "killed" ? "was killed" : `finished with exit code ${info.exitCode}`;
    // Only interactive-server CRASHES reach here (a clean stop is marked reported and
    // never drains). Tell the model to report, not restart — the user closing/crashing
    // their app is not a cue to relaunch it.
    const guidance = isInteractiveServerCommand(info.command)
      ? "This is a dev server / app that stopped on its own. Tell the user what happened, but do NOT restart it yourself unless they ask — they control when their app runs."
      : "If it failed, tell the user briefly what went wrong and propose a fix — don't change files unless they agree.";
    return (
      `[Background shell #${info.id} (\`${info.command}\`) ${status}.]\n` +
      `Recent output:\n${tail || "(no output)"}\n\n` +
      guidance
    );
  });
}

/**
 * Produce Mindweave's next reply for the latest user message already on
 * `session.transcript`. Appends the assistant/tool turns it generates and
 * returns the final assistant text.
 */
/**
 * Whether a tool call may run in the PARALLEL lane (pure — unit-tested). A tool's
 * per-args `isConcurrencySafe` wins when present (e.g. a read-only sub-agent is safe
 * to fan out, an editing one is not); otherwise the default is read-only ⇒ safe.
 */
export function callIsConcurrencySafe(
  tool: { readOnly: boolean; isConcurrencySafe?: (args: Record<string, unknown>) => boolean },
  args: Record<string, unknown>,
): boolean {
  return tool.isConcurrencySafe ? tool.isConcurrencySafe(args) : tool.readOnly;
}

export async function respond(session: Session, options: RespondOptions = {}): Promise<string> {
  // Make sure the provider serving the selected model is loaded before anything
  // in this turn reaches for it. Cached after the first call, so this is free on
  // every subsequent turn, and it keeps `activeDriver()` safe to call synchronously
  // from here down (including from inside a tool).
  await ensureDriver(session.modelConfig.model);
  const planMode = session.toolContext.planMode ?? false;
  const tools = toolSchemas({ planMode, readOnlyOnly: session.toolContext.readOnlyTools });
  const lookup = (name: string) => findTool(name);
  const stepLimit = options.maxSteps ?? STEP_BUDGET;
  // Sinks the spawn_subagent tool reuses (it only ever gets the ToolContext, not the
  // Session): fork a scoped child, forward the child's usage to this turn's meter,
  // and share this turn's abort signal so Esc stops a sub-agent too.
  session.toolContext.forkChild = (task, opts) => forkSession(session, task, opts);
  session.toolContext.reportUsage = (u) => options.onEvent?.({ type: "usage", ...u });
  // The raw event sink, so spawn_subagent can surface a child's nested activity
  // (its lifecycle + tagged tool calls) up this same stream instead of running dark.
  session.toolContext.emitEvent = options.onEvent;
  session.toolContext.abortSignal = options.signal;

  // WORKING-DIRECTORY RESET. Each turn starts at the project root — the working
  // directory is already set to the correct project directory automatically. Within a
  // turn cd still persists (so a multi-step command sequence works), but it never
  // carries a stale `cd` into the next
  // turn — the bug where `cd src-tauri` run in two turns became `…/src-tauri/src-tauri`.
  // The primary root (session.cwd) is fixed; only toolContext.cwd moves.
  session.toolContext.cwd = session.cwd;

  // TASK-BOUNDARY SWEEP. If the previous turn finished a task (a todo list completed)
  // and this new message opens a DIFFERENT one (not a "continue"), close the finished
  // task out now — sweep its tool results and status recaps down hard — so a weaker
  // model can't drift back to already-done work. This is the fix for "the model went
  // back to a task from 6 turns ago." Cheap (no model call); the live working set keeps
  // current file content regardless.
  if (session.taskJustCompleted && !isContinuation(lastUserText(session))) {
    const swept = microcompact(session.transcript, KEEP_LAST_N_BOUNDARY);
    if (swept.cleared > 0 || swept.recapsCleared > 0) {
      session.transcript = swept.entries;
      reconcileReadsAfterClear(session, swept.clearedIds);
      // Silent by design — closing out a finished task is background housekeeping, not
      // something the user should watch scroll by.
    }
  }
  session.taskJustCompleted = false;

  // SESSION MEMORY. At a natural break (turn start), if the transcript has grown enough
  // since the last refresh, update the maintained "state of this session" notes. They
  // live outside the transcript, so compaction never erodes them — which is what lets a
  // session run indefinitely without slowly losing the thread. One cheap call, gated so
  // it fires rarely; degrade-safe.
  if (
    shouldUpdateSessionMemory(
      estimateEntriesTokens(session.transcript),
      session.sessionMemoryTokens ?? 0,
      session.sessionMemoryInit ?? false,
    )
  ) {
    // Silent by design — session memory is background machinery, not something the user
    // watches. No activity line; it just keeps the notes current.
    await updateSessionMemory(session);
    await options.persist?.(); // durable: the notes sidecar is written by the persister
  }

  // Computed once per turn from the current working set (refreshes as reads change
  // across turns); kept tiny to bound per-turn token cost.
  const relevantMap = await relevantMapText(session);
  // Background shells that finished since last turn — surfaced to the model once.
  const bgEvents = await backgroundEventNotes(session);

  // Per-task guards: cost/time ceilings (opt-in) alongside the step budget. Every
  // call's usage is summed so the ceiling reflects the whole task.
  const limits = taskLimits();
  const startedAt = Date.now();
  const usages: Usage[] = [];

  // Verification-gate bookkeeping for this turn: did the model change any file,
  // did it ever run a check, and have we already nudged once (one-shot).
  let mutatedThisTurn = false;
  let verifiedThisTurn = false;
  let verifyNudged = false;
  // Re-scope guard: once the model completes a WHOLE todo list, spinning up a
  // fresh one and pressing on within the same turn is self-assigned scope the user
  // never asked for (the "did the task three times" runaway). This flips true when
  // a todo list is fully completed; a new pending list afterward triggers a pause.
  let completedAList = false;
  // Background-poll guard: consecutive steps that did nothing but poll a still-running
  // background shell. Once past the allowance, stop the wait-loop (the model won't
  // stop on the prose nudge alone). Any step that does real work resets it to 0.
  let bgPollStreak = 0;
  // Repeat-failure breaker: consecutive steps that failed the SAME way (identical error
  // signature). A weaker model can grind the same broken command for dozens of steps;
  // once the streak crosses REPEAT_FAIL_LIMIT we stop losslessly and surface the error.
  let repeatFailStreak = 0;
  let lastFailSig: string | null = null;
  let lastFailOutput = "";

  // Seal whatever files this turn edits into one restorable checkpoint (/undo),
  // no matter how the turn ends (finish, pause, interrupt, throw). Labeled with
  // the request that drove it. No-op when nothing was edited.
  const turnLabel = lastUserText(session);
  try {
    return await runTurn();
  } finally {
    session.toolContext.checkpoints?.seal(turnLabel);
  }

  // The turn's model↔tool loop. Kept as a closure so the try/finally above owns
  // every exit path; it reads the flags/usages declared in the enclosing scope.
  async function runTurn(): Promise<string> {
  for (let step = 0; step < stepLimit; step++) {
    if (options.signal?.aborted) return interrupted(session);
    // Stop before another (billable) call if a cost/time ceiling is hit — pause
    // losslessly, exactly like the step budget, so the user can raise it and resume.
    const limitReason = taskLimitReason(summarizeTask(usages, session.modelConfig.model), Date.now() - startedAt, limits);
    if (limitReason) return pauseTask(session, `hit the ${limitReason}`);
    await maybeCompact(session, options);

    // The live working set: current contents of the files being worked on, rebuilt
    // each step (so it reflects edits made mid-turn) and injected in the volatile tail.
    // `workingSetFull` lets read_file short-circuit a re-read of a file already shown.
    const workingSet = await buildWorkingSet(session.toolContext);
    session.toolContext.workingSetFull = workingSet.fullPaths;

    let result: StreamResult;
    const request = buildRequest(session, relevantMap, workingSet.text, bgEvents, tools);
    try {
      result = await streamModel(request, options);
    } catch (error) {
      if (isAbort(error)) return interrupted(session);
      throw error;
    }
    const { content, toolCalls } = result;
    // Every model call's usage counts toward the task total — a task (one turn)
    // may span several calls across tool rounds, and the UI sums them.
    emitUsage(result, options);
    if (result.usage) usages.push(result.usage);

    // The provider can end a turn for reasons that are NOT "finished answering".
    // Without checking, a reply cut off at the output ceiling looks identical to a
    // complete one and the loop carries on with half an answer.
    if (result.stop && result.stop !== "end") {
      const note = stopReasonNote(result.stop);
      if (content.trim()) session.transcript.push({ role: "assistant", content });
      await options.persist?.();
      return pauseTask(session, note);
    }

    // No tool calls → the model is done. Record the reply.
    if (toolCalls.length === 0) {
      session.transcript.push({ role: "assistant", content });
      await options.persist?.(); // durable: the reply is on disk before we return
      // Verification gate: it edited files but never checked them. Nudge once and
      // let it continue — a fact-based reminder, not a decision about the code.
      if (VERIFY_GATE && !planMode && mutatedThisTurn && !verifiedThisTurn && !verifyNudged) {
        verifyNudged = true;
        session.transcript.push({ role: "user", content: VERIFY_NUDGE });
        continue;
      }
      return content;
    }

    // Record the assistant's tool request so the conversation stays well-formed.
    const records: ToolCallRecord[] = toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    session.transcript.push({ role: "assistant", content, toolCalls: records });
    // Durable BEFORE running the tools: if the machine dies mid-tool, the resume path
    // sees these dangling tool_calls and reconciles them (reconcileInterruptedTools).
    await options.persist?.();

    // Announce every tool the model chose, in its order, BEFORE running any —
    // the UI's reveal queue paces them and a slow tool (test/run) can show a live
    // "running" state until its end event lands.
    for (const call of toolCalls) {
      options.onEvent?.({ type: "tool", phase: "start", id: call.id, name: call.name, args: parseArgs(call.arguments) });
    }

    // Concurrency-safe calls run in PARALLEL; the rest run one at a time, in order
    // (parallel edits to one file race, and an edit must see the last write). A call
    // is concurrency-safe when the tool says so for THESE args (isConcurrencySafe) —
    // e.g. a read-only sub-agent, which lets the model fan out research — otherwise
    // the default is: read-only ⇒ safe, mutating ⇒ serial.
    const concurrencySafe = (call: (typeof toolCalls)[number]): boolean => {
      const tool = lookup(call.name);
      return tool ? callIsConcurrencySafe(tool, parseArgs(call.arguments)) : false;
    };
    const parallelCalls = toolCalls.filter(concurrencySafe);
    const serialCalls = toolCalls.filter((call) => !concurrencySafe(call));

    const runCall = async (call: (typeof toolCalls)[number]) => {
      const tool = lookup(call.name);
      if (!tool) {
        return { call, output: `Error: unknown tool '${call.name}'.`, summary: `unknown tool '${call.name}'`, isError: true, detail: undefined as string | undefined };
      }
      // Belt-and-suspenders for plan mode: the schema filter already hides mutating
      // tools, but if the model calls one anyway, refuse it instead of running it.
      if (planMode && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but you're in plan mode. Present your plan instead; the user will approve and switch out of plan mode to carry it out.`,
          summary: `blocked in plan mode`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // A read-only sub-agent: same schema-hiding + refusal, without the plan framing.
      if (session.toolContext.readOnlyTools && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but this sub-agent is read-only. Report your findings instead.`,
          summary: `blocked (read-only sub-agent)`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // Sentinel mode: confirm every mutating action with the human first. Gated
      // here (the single execution choke point) so it covers every mutating tool
      // uniformly — including subagent edits. Fails safe: no approval channel, or an
      // unclear answer, refuses rather than runs.
      const ctx = session.toolContext;
      if (!tool.readOnly && ctx.guarded && !ctx.guardAllowAll) {
        const args = parseArgs(call.arguments);
        const choice = ctx.requestApproval
          ? await ctx.requestApproval(guardQuestion(call.name, args), [...GUARD_OPTIONS])
          : undefined;
        const decision = interpretGuardChoice(choice);
        if (decision === "refuse") {
          return { call, output: GUARD_REFUSAL, summary: `declined ${call.name}`, isError: true, detail: undefined as string | undefined };
        }
        if (decision === "allow-all") ctx.guardAllowAll = true;
      }
      const result = await tool.execute(parseArgs(call.arguments), session.toolContext);
      return { call, output: result.output, summary: result.summary, isError: result.isError, detail: result.detail };
    };

    // Emit each tool's END the instant IT finishes — not batched after the whole
    // turn — so the UI can resolve that row promptly (and show it already-expanded
    // rather than a header that pops its output in later). Transcript order is still
    // the model's call order (the sort below); only the UI events go out eagerly.
    const runAndEmit = async (call: (typeof toolCalls)[number]) => {
      const r = await runCall(call);
      options.onEvent?.({
        type: "tool",
        phase: "end",
        id: r.call.id,
        name: r.call.name,
        summary: r.summary ?? r.call.name,
        error: r.isError ?? false,
        detail: r.detail,
      });
      return r;
    };
    const results = await Promise.all(parallelCalls.map(runAndEmit));
    for (const call of serialCalls) {
      results.push(await runAndEmit(call));
    }
    // Hand results back in the model's original call order (start events were emitted
    // in that order too), no matter which lane each call ran in.
    const callOrder = new Map(toolCalls.map((c, i) => [c.id, i]));
    results.sort((a, b) => (callOrder.get(a.call.id) ?? 0) - (callOrder.get(b.call.id) ?? 0));

    // Track the verification-gate facts: a successful edit/write to a file with a
    // runtime surface counts as a mutation that needs checking — a docs-only edit
    // (MINDWEAVE.md, a README) does NOT, so the gate never fires on it. A diagnostics/
    // build/test check counts ONLY when it PASSED. A failing check (non-zero exit /
    // isError) is not verification — it means work remains, so the gate must stay
    // unsatisfied and nudge again rather than let a red build finish.
    for (const r of results) {
      if (!r.isError && mutationNeedsVerification(r.call.name, parseArgs(r.call.arguments))) mutatedThisTurn = true;
      if (!r.isError && isVerification(r.call.name, parseArgs(r.call.arguments))) verifiedThisTurn = true;
    }

    for (const result of results) {
      // The end event already went out eagerly (runAndEmit) the moment this tool
      // finished; here we only record it into the transcript, in call order.
      session.transcript.push({
        role: "tool",
        toolCallId: result.call.id,
        content: result.output,
        // Display fields, stored so a resumed session replays the exact same row
        // (summary line + diff/detail). Ignored when building the wire request.
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.isError ? { isError: true } : {}),
      });
    }
    await options.persist?.(); // durable: tool results recorded, transcript well-formed

    // Re-scope guard. A todo_write that clears the list ("all tasks completed")
    // marks a natural stopping point: the requested work is done. If the model
    // then opens a NEW list of pending work in the same turn, it's taking on scope
    // the user didn't ask for — pause losslessly here and hand the wheel back,
    // rather than letting it rebuild the same thing over and over (a weaker model
    // won't self-stop the way a stronger one does; this is the deterministic
    // backstop for that). The decision is a pure fn (verify.ts) so it's unit-tested.
    const reScope = reScopeCheck(
      completedAList,
      results.map((r) => ({ name: r.call.name, summary: r.summary })),
      session.toolContext.todos,
    );
    completedAList = reScope.completed;
    // Remember, for the NEXT turn's boundary sweep, that a task just finished here.
    session.taskJustCompleted = reScope.completed;
    if (reScope.pause) return pauseReScope(session);

    // Background-poll guard. A still-running shell's completion is pushed to the model
    // automatically, so polling it in a loop is pure waste and reads as spam ("still
    // compiling… let me check again", over and over). Allow a single informative poll,
    // then stop the wait-loop here — deterministically, because a weaker model doesn't
    // stop on the prose nudge in the tool result. Nothing is lost: when the shell
    // finishes, backgroundEventNotes wakes the model to report it.
    if (isBackgroundPollStep(results.map((r) => ({ name: r.call.name, summary: r.summary })))) {
      bgPollStreak++;
      if (bgPollStreak > BG_POLL_ALLOWANCE) return pauseForBackgroundPoll(session);
    } else {
      bgPollStreak = 0;
    }

    // Repeat-failure breaker. If this step failed exactly the way the last one(s) did —
    // same tools, same error — the model is stuck grinding a broken command instead of
    // changing course. Count consecutive identical failures; once past the limit, stop
    // and hand the real error back to the user rather than burning steps (and context)
    // on a doomed retry loop. Keyed on the error MESSAGE, so a run of near-identical
    // commands that all fail the same way still trips it.
    const failSig = stepFailureSignature(
      results.map((r) => ({ name: r.call.name, output: r.output, isError: !!r.isError })),
    );
    if (failSig) {
      repeatFailStreak = failSig === lastFailSig ? repeatFailStreak + 1 : 1;
      lastFailSig = failSig;
      lastFailOutput = results.find((r) => r.isError)?.output ?? "";
      if (repeatFailStreak >= REPEAT_FAIL_LIMIT) return pauseForRepeatedFailure(session, lastFailOutput);
    } else {
      repeatFailStreak = 0;
      lastFailSig = null;
    }
  }

  // Step ceiling reached without the model finishing. Don't spend another call
  // forcing a (misleading) wrap-up the way a tools-off final turn would — that
  // reads as "done" when it isn't. Pause cleanly instead: the transcript, task
  // list, and working set are all intact, so telling Mindweave to continue resumes
  // exactly here with nothing lost, and the user stays in control of the spend.
  return pauseTask(session, `reached the step budget of ${stepLimit} tool steps in one turn`);
  }
}

/** The most recent user request in the transcript, clipped — labels a checkpoint. */
function lastUserText(session: Session): string {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const e = session.transcript[i]!;
    if (e.role === "user") {
      const oneLine = e.content.replace(/\s+/g, " ").trim();
      return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
    }
  }
  return "(edits)";
}

/** Lossless hand-back when the model finishes its task list and then starts a new
 *  one in the same turn (the re-scope guard) — a natural checkpoint to let the user
 *  steer instead of the model taking on scope it wasn't asked for. */
function pauseReScope(session: Session): string {
  const msg =
    "(I've finished the task list for what you asked. I have ideas for taking it " +
    "further, but I've stopped here so you can steer — rather than piling on new scope " +
    'on my own. Tell me which direction you want, or say "keep going" to continue.)';
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Lossless stop when the model is stuck polling a still-running background shell.
 *  The shell's completion is pushed to the model automatically, so there's nothing
 *  to do but wait — end the turn cleanly instead of looping "still running" checks.
 *  Deliberately worded as a status line to the user, not a "paused" apology. */
function pauseForBackgroundPoll(session: Session): string {
  const msg =
    "It's still running in the background. I'll stop checking and let you know as soon " +
    "as it finishes — no need to keep watching.";
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Lossless stop when the model repeats the same failing step over and over. Rather than
 *  grind a broken command for dozens of steps, we surface the actual error and hand the
 *  wheel back — the model (or user) can then change approach instead of retrying blindly. */
function pauseForRepeatedFailure(session: Session, errorOutput: string): string {
  const firstLine =
    errorOutput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("+") && !/^~+$/.test(l)) ?? "the same error";
  const clipped = firstLine.length > 200 ? firstLine.slice(0, 197) + "…" : firstLine;
  const msg =
    `I've hit the same failure several times in a row and I'm not making progress, so I've ` +
    `stopped rather than retry the same thing again. The error was:\n\n${clipped}\n\n` +
    `Tell me how you'd like to proceed, or I can try a different approach.`;
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Record and return a clean, lossless pause reply (well-formed transcript) when a
 *  guard trips — step budget or a cost/time ceiling. Saying "continue" resumes. */
function pauseTask(session: Session, reason: string): string {
  const pause =
    `(Paused — ${reason}. The task isn't finished, but nothing is lost: your progress, ` +
    `edits, and task list are saved. Say "continue" to pick up exactly where I left off.)`;
  session.transcript.push({ role: "assistant", content: pause });
  return pause;
}

/**
 * Plain-language reason a turn ended early, for the pause message. Kept here (not
 * in a driver) because it's user-facing copy: every provider maps its own
 * vocabulary onto the shared StopReason, and the wording is the same either way.
 */
export function stopReasonNote(stop: Exclude<StopReason, "end">): string {
  switch (stop) {
    case "truncated":
      return "the model hit its output limit mid-answer, so the reply above is incomplete";
    case "refused":
      return "the provider's safety filter declined this request";
    case "overflow":
      return "the conversation no longer fits the model's context window";
  }
}

/** One streaming model call: forwards the model's reasoning/answer deltas to the
 *  UI as engine events, and returns the assembled turn (content + tool calls +
 *  usage) for the loop to record. */
function streamModel(request: ModelRequest, options: RespondOptions): Promise<StreamResult> {
  return activeDriver().streamTurn(request, {
    signal: options.signal,
    onEvent: (e) => {
      if (e.type === "reasoning") options.onEvent?.({ type: "reasoning", delta: e.delta });
      else if (e.type === "text") options.onEvent?.({ type: "text", delta: e.delta });
      // tool_start / tool_args deltas are not forwarded: the engine emits richer
      // tool events (with parsed args + result summary) around execution instead.
    },
  });
}

/** Report a turn's token usage to the UI, if the provider returned it. */
function emitUsage(result: StreamResult, options: RespondOptions): void {
  if (result.usage) {
    options.onEvent?.({ type: "usage", ...result.usage });
  }
}

/**
 * Run the compaction cascade if the transcript has grown enough: microcompact
 * (lossless) first, then autocompact (a summary) if still over the higher bar.
 */
async function maybeCompact(session: Session, options: RespondOptions): Promise<void> {
  const model = session.modelConfig.model;
  // Model-anchored bars (env still overrides), so the thresholds are right per model
  // instead of a fixed number — and a longer/stronger model automatically gets more room.
  const microBar = envInt("MINDWEAVE_MICROCOMPACT_TOKENS", microCompactThreshold(model));
  const autoBar = envInt("MINDWEAVE_AUTOCOMPACT_TOKENS", autoCompactThreshold(model));

  if (estimateEntriesTokens(session.transcript) >= microBar) {
    const { entries, cleared, clearedIds, recapsCleared } = microcompact(session.transcript);
    if (cleared > 0 || recapsCleared > 0) {
      session.transcript = entries;
      reconcileReadsAfterClear(session, clearedIds);
      // Silent by design — trimming stale context is background machinery.
    }
  }
  // Circuit-breaker: once autocompact has failed MAX_COMPACT_FAILURES times this
  // session, stop trying (the transcript is likely irrecoverable) rather than burning
  // a doomed summarizer call every turn.
  if (
    estimateEntriesTokens(session.transcript) >= autoBar &&
    (session.compactFailures ?? 0) < MAX_COMPACT_FAILURES
  ) {
    await autocompact(session, options);
  }
}

/**
 * When microcompact clears a file read's body, that file's content is gone from
 * context — but the read ledger still said "you have it," so a re-read would be
 * wrongly deduped to "unchanged, use your earlier read" (which no longer exists).
 * Drop those files from the ledger so a needed re-read returns real content again —
 * UNLESS the file's CURRENT FULL content is still in the live working set (the volatile
 * tail), where the ledger entry stays valid. Keying off the working set's full-content
 * set (not a fixed file count) means a localized file — only partially present — is
 * correctly dropped, so a re-read of it isn't wrongly deduped to a stub.
 */
function reconcileReadsAfterClear(session: Session, clearedIds: string[]): void {
  if (clearedIds.length === 0) return;
  const ctx = session.toolContext;
  const active = ctx.workingSetFull ?? new Set<string>();
  // Map each tool result's id back to the read_file/read_symbol call that produced it.
  const callById = new Map<string, ToolCallRecord>();
  for (const e of session.transcript) {
    if (e.role === "assistant" && e.toolCalls) for (const tc of e.toolCalls) callById.set(tc.id, tc);
  }
  for (const id of clearedIds) {
    const call = callById.get(id);
    if (!call || (call.name !== "read_file" && call.name !== "read_symbol")) continue;
    try {
      const raw = JSON.parse(call.arguments) as { path?: unknown };
      if (typeof raw.path !== "string") continue;
      const abs = resolvePath(ctx, raw.path);
      if (!active.has(abs)) ctx.reads.delete(abs);
    } catch {
      /* malformed args — nothing to reconcile */
    }
  }
}

/**
 * Force a full summarizing compaction now (the `/compact` command), regardless
 * of size. Safe on a short transcript — it just summarizes what's there.
 */
export async function compactNow(session: Session, options: RespondOptions = {}): Promise<void> {
  await autocompact(session, options);
}

/**
 * Replace the old prefix of the transcript with a 9-section summary, keep the
 * last N turns verbatim, then re-read the working-set files so nothing the model
 * was mid-edit on is lost. The one model call here is small relative to
 * DeepSeek's 1M window (the transcript triggered at ~90K), so — unlike agents on
 * a ~200K model — there's no prompt-too-long risk to retry around.
 */
async function autocompact(session: Session, options: RespondOptions): Promise<void> {
  if (session.transcript.length === 0) return;
  // Automatic compaction is silent (background machinery). The user-invoked /compact
  // path shows its own progress line from the command handler.

  let summary: string;
  try {
    // Summaries don't need reasoning — use the chosen model with thinking off.
    const { content } = await activeDriver().toolTurn({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${formatTranscriptForSummary(session.transcript)}\n\n${SUMMARY_REQUEST}` }],
      model: { ...session.modelConfig, thinking: false },
    });
    summary = content.trim();
  } catch {
    // Summarizer failed — keep the full transcript rather than lose it, and count the
    // failure so the circuit-breaker can stop retrying a doomed compaction.
    session.compactFailures = (session.compactFailures ?? 0) + 1;
    return;
  }
  if (!summary) return;
  session.compactFailures = 0; // a clean compaction resets the breaker

  // No explicit post-summary re-read needed: the live working set (buildWorkingSet)
  // injects the current contents of the files being worked on in the volatile tail
  // every step, so nothing the model was mid-edit on is lost across the summary.
  session.transcript = spliceSummary(session.transcript, summary, KEEP_LAST_N);
}

/** Parse a tool call's raw JSON arguments; malformed payload → {} so the tool
 *  returns its own clear error rather than crashing the loop. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
