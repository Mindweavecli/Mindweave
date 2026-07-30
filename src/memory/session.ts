/**
 * session.ts — create a fresh session or resume a saved one.
 *
 * A `Session` bundles the transcript, the tool context (live cwd + read ledger),
 * and the project memory. This is the client-side init that does the disk reads
 * (MINDWEAVE.md, a saved transcript); the engine receives a ready Session and never
 * touches the filesystem itself.
 */
import { promises as fs, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ToolContext } from "../tools/types.js";
import { resolvePath, nextTouch } from "../tools/paths.js";
import type { Session, Entry } from "./types.js";
import { latestSession, loadMeta, loadTranscript, loadSessionNotes } from "./store.js";
import { startChassis } from "../alternator/lane.js";
import { BackgroundShells } from "../tools/backgroundShells.js";
import { Checkpoints } from "../tools/checkpoints.js";
import { projectContextText } from "../project/context.js";
import { loadGovernance } from "../governor/index.js";
import type { Governance } from "../governor/types.js";
import { loadModelConfig } from "../dynamo/model.js";
import { ensureMemoryDir, loadMemoryIndex, memoryDir } from "./autoMemory.js";

/** Read the project's MINDWEAVE.md (facts the agent should always know). "" if none. */
async function loadProjectMemory(cwd: string): Promise<string> {
  try {
    return (await fs.readFile(join(cwd, "MINDWEAVE.md"), "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Re-read MINDWEAVE.md into the live session. The model edits MINDWEAVE.md mid-session (it
 * maintains it), but `projectMemory` sits in the cached system prompt and was frozen
 * at session start — so the model kept seeing a STALE project memory. Calling this
 * before each turn keeps it current (same bytes when unchanged → prompt cache holds;
 * a real edit breaks the prefix once, which is correct).
 */
export async function reloadProjectMemory(session: Session): Promise<void> {
  session.projectMemory = await loadProjectMemory(session.cwd);
}

/**
 * Seed the read-ledger with MINDWEAVE.md when it exists on disk, so the model can UPDATE
 * the project's own memory file without a redundant read_file first. MINDWEAVE.md's content
 * is already loaded into the system prompt (projectMemory), so the read-before-edit gate
 * would otherwise trip on a file the model effectively already has — surfacing the
 * confusing "MINDWEAVE.md has not been read this session" error on routine housekeeping.
 * Keyed via resolvePath so it matches exactly what the edit gate looks up. Recorded
 * full:false (the model works from a window, never a held whole-file copy) so it can
 * never wrongly short-circuit a genuine read_file. Best-effort; no MINDWEAVE.md => no-op.
 */
async function seedProjectMemoryRead(ctx: ToolContext, projectMemory: string): Promise<void> {
  if (!projectMemory) return;
  const abs = resolvePath(ctx, "MINDWEAVE.md");
  try {
    const st = await fs.stat(abs);
    ctx.reads.set(abs, { mtimeMs: st.mtimeMs, size: st.size, full: false, touchedAt: nextTouch() });
  } catch {
    // No MINDWEAVE.md on disk — nothing to seed.
  }
}

/** Ensure the memory dir exists (so the model never mkdirs) and read its index. */
async function loadMemory(cwd: string): Promise<string> {
  await ensureMemoryDir(cwd);
  return loadMemoryIndex(cwd);
}

function freshToolContext(cwd: string, governance: Governance, roots: string[]): ToolContext {
  // Start the alternator: one code map per root warms up in the background while
  // the session is already usable. The forbidden config + skill catalog come from
  // the governor so the tools can enforce/invoke them.
  const chassisByRoot = new Map(roots.map((root) => [root, startChassis(root)] as const));
  return {
    cwd,
    roots,
    reads: new Map(),
    chassis: chassisByRoot.get(cwd), // the primary root's map (drives the auto-map)
    chassisByRoot,
    backgroundShells: new BackgroundShells(),
    checkpoints: new Checkpoints(),
    todos: [],
    // Same governance object as Session.governance — shared so mid-session edits
    // (a new rule, a new forbidden path) are visible to both the tools and the
    // engine's prompt without a reload.
    governance,
  };
}

/** The framing prepended to a sub-agent's task — it works alone and reports back. */
const SUBAGENT_PREAMBLE =
  "You are a focused sub-agent spawned by the main Mindweave agent to complete ONE task and report back. " +
  "Work autonomously with your tools — you cannot ask the user questions, and you do not see the main " +
  "conversation, so rely only on the task below. Do EXACTLY what it asks and stay inside its boundaries — " +
  "don't widen the scope, and don't change files the task didn't name. Stop as soon as the objective is met " +
  "rather than exploring further. When finished, reply with a DISTILLED result — the answer the main agent " +
  "needs, with concrete file:line references, and nothing else (no play-by-play). If the task specifies an " +
  "output format, follow it exactly. Keep it tight (aim for well under a page): the main agent sees only " +
  "your final message, not your intermediate steps.\n\nTask:\n";

/**
 * A scoped child session for a sub-agent. It gets its OWN transcript (seeded with
 * the task) and its OWN read ledger + todo list, so its work is isolated and never
 * pollutes the parent's working set. It SHARES the parent's code map, checkpoints
 * (so its edits are undoable too), governance, and approval channel by reference —
 * everything the parent already stood up. Only the child's final reply crosses back
 * to the parent, through the spawn tool.
 */
export function forkSession(parent: Session, task: string, opts: { readOnly?: boolean } = {}): Session {
  const p = parent.toolContext;
  const childContext: ToolContext = {
    ...p,
    reads: new Map(),
    todos: [],
    subagentDepth: (p.subagentDepth ?? 0) + 1,
    readOnlyTools: opts.readOnly === true ? true : p.readOnlyTools,
    // Cleared so the child re-derives its own from the engine when it runs.
    guardAllowAll: p.guardAllowAll,
  };
  return {
    ...parent,
    id: randomUUID(),
    createdAt: Date.now(),
    transcript: [{ role: "user", content: SUBAGENT_PREAMBLE + task }],
    toolContext: childContext,
  };
}

/** A brand-new session rooted at `cwd` (defaults to the process cwd). */
export async function createSession(cwd: string = process.cwd()): Promise<Session> {
  const [projectMemory, memoryIndex, projectContext, governance, modelConfig] = await Promise.all([
    loadProjectMemory(cwd),
    loadMemory(cwd),
    projectContextText(cwd),
    loadGovernance(cwd),
    loadModelConfig(cwd),
  ]);
  const toolContext = freshToolContext(cwd, governance, [cwd]);
  await seedProjectMemoryRead(toolContext, projectMemory);
  return {
    id: randomUUID(),
    cwd,
    createdAt: Date.now(),
    transcript: [],
    toolContext,
    projectMemory,
    memoryDir: memoryDir(cwd),
    memoryIndex,
    projectContext,
    governance,
    modelConfig,
  };
}

/**
 * Resume the most recent saved session for `cwd` (or a specific `id`), returning
 * a live Session with its transcript loaded. Returns null when there's nothing
 * to resume. The tool context starts fresh — the model re-reads files before it
 * edits them (that's the read-before-edit contract), so a resumed session simply
 * re-reads as needed rather than trusting a stale ledger.
 */
/**
 * Repair a transcript that was cut off mid-tool. If the session was closed between the
 * model issuing tool calls and their results being recorded (PC shutdown, force-kill,
 * crash), some `tool_calls` have no matching `tool` result — which the provider rejects
 * (breaking /continue) and which hides that the tool never finished. For every
 * unanswered call we insert a synthetic result, right after its assistant message so the
 * tool group stays contiguous, marking it interrupted so the model re-checks the real
 * state before trusting or repeating it. Pure; returns a new array (unchanged if nothing
 * was dangling). Exported for tests.
 */
export function reconcileInterruptedTools(transcript: Entry[]): Entry[] {
  const answered = new Set<string>();
  for (const e of transcript) if (e.role === "tool") answered.add(e.toolCallId);

  let repaired = false;
  const out: Entry[] = [];
  for (const e of transcript) {
    out.push(e);
    if (e.role === "assistant" && e.toolCalls?.length) {
      for (const call of e.toolCalls) {
        if (answered.has(call.id)) continue;
        answered.add(call.id); // guard against a (malformed) duplicate id
        repaired = true;
        out.push({
          role: "tool",
          toolCallId: call.id,
          content:
            `[interrupted] '${call.name}' did not finish — the session was closed before this tool ` +
            `returned, so its effect on disk/state is unknown. Re-check the current state (files, ` +
            `processes, installs) before relying on it or running it again.`,
          summary: `${call.name} — interrupted (session closed)`,
          isError: true,
        });
      }
    }
  }
  return repaired ? out : transcript;
}

export async function resumeSession(
  cwd: string = process.cwd(),
  id?: string,
): Promise<Session | null> {
  const meta = id ? await loadMeta(cwd, id) : await latestSession(cwd);
  if (!meta) return null;

  const loaded = await loadTranscript(cwd, meta.id);
  if (!loaded || loaded.length === 0) return null;
  // A session closed mid-tool (PC shutdown, force-kill) leaves the model's tool_calls
  // with no results — invalid to replay and silent about what didn't finish. Repair it
  // so /continue resumes cleanly and the model re-checks the interrupted step.
  const transcript = reconcileInterruptedTools(loaded);

  const [projectMemory, memoryIndex, projectContext, governance, modelConfig, sessionMemory] = await Promise.all([
    loadProjectMemory(cwd),
    loadMemory(cwd),
    projectContextText(cwd),
    loadGovernance(cwd),
    loadModelConfig(cwd),
    loadSessionNotes(cwd, meta.id),
  ]);
  // Restore any added roots that still exist on disk (primary first).
  const extra = (meta.extraRoots ?? []).filter((r) => existsSync(r));
  const roots = [cwd, ...extra];
  const toolContext = freshToolContext(cwd, governance, roots);
  await seedProjectMemoryRead(toolContext, projectMemory);
  return {
    id: meta.id,
    cwd,
    createdAt: meta.createdAt ?? Date.now(),
    transcript,
    toolContext,
    projectMemory,
    memoryDir: memoryDir(cwd),
    memoryIndex,
    projectContext,
    governance,
    modelConfig,
    // The maintained session notes survive a resume, so a continued session keeps its
    // crisp running state. The watermark starts fresh; it'll refresh as it grows again.
    ...(sessionMemory ? { sessionMemory, sessionMemoryInit: true } : {}),
  };
}
