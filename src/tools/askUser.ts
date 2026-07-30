/**
 * askUser.ts — a structured question to the user.
 *
 * Underspecification is one of the top real-world failure modes for coding agents:
 * faced with an ambiguous request, a model guesses and builds the wrong thing.
 * This gives the model an explicit escape hatch — ask a focused question with a
 * few concrete options — instead of guessing. It reuses the same client approval
 * channel the forbidden-lift flow uses (`ctx.requestApproval`), which renders the
 * question + options and returns the chosen one.
 *
 * Model-work boundary: WHETHER to ask is the model's judgment (guided by the
 * prompt: ask when genuinely blocked, don't overuse it). This tool only carries
 * the question to the human and the answer back.
 */
import type { Tool, ToolResult } from "./types.js";

export const askUserTool: Tool = {
  name: "ask_user",
  readOnly: true,
  description:
    "Ask the user a focused question when the task is genuinely ambiguous or " +
    "underspecified and you cannot proceed well without their input (e.g. which of " +
    "two real approaches they want, a missing requirement, an unclear denial). " +
    "Provide 2-4 concrete options; the user's choice is returned to you. Use it " +
    "sparingly — do not ask about things you can decide with sensible defaults or " +
    "discover by reading the project. Prefer acting when the answer is obvious.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["question", "options"],
    properties: {
      question: {
        type: "string",
        description: "The specific question to ask. Clear and self-contained.",
      },
      options: {
        type: "array",
        description: "2-4 concrete answer options for the user to choose from.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
      : [];
    if (!question) return fail("`question` is required.");
    if (options.length < 2) return fail("provide at least 2 concrete `options`.");

    // No approval channel (headless run / tests): can't ask — tell the model to
    // proceed on its best judgment rather than stall.
    if (!ctx.requestApproval) {
      return {
        output:
          "Can't ask the user right now (no interactive channel). Proceed with your best " +
          "judgment using a sensible default, and note the assumption in your reply.",
        summary: "ask_user unavailable — proceed with a default",
      };
    }

    const choice = await ctx.requestApproval(question, options.slice(0, 4));
    return {
      output: `The user chose: ${choice}`,
      summary: `asked: ${clip(question)} → ${clip(choice)}`,
    };
  },
};

function clip(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
