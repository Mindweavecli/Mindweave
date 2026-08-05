/**
 * help.ts — what `/help` prints.
 *
 * Rendered from the SAME command list the input's autocomplete offers, plus the
 * project skills and MCP prompts that are live in this session. A second
 * hand-maintained list of commands would be a literal standing in for something
 * that already has a source of truth, and it would go stale the first time a
 * command was added — see BOUNDARY.md.
 *
 * Pure: takes the lists, returns the text. The caller does the gathering.
 */

export interface CommandInfo {
  name: string;
  description: string;
}

/** A named group of commands, rendered under its own heading. Empty groups are dropped. */
export interface HelpSection {
  title: string;
  commands: readonly CommandInfo[];
}

/** Right-pad a command name so the descriptions line up in a column. */
function column(commands: readonly CommandInfo[]): number {
  return commands.reduce((w, c) => Math.max(w, c.name.length), 0);
}

/**
 * Render the help text. Sections with no commands are omitted entirely, so a
 * project with no skills and no MCP servers sees a clean list rather than empty
 * headings.
 */
export function formatHelp(sections: readonly HelpSection[]): string {
  const live = sections.filter((s) => s.commands.length > 0);
  // One column width across ALL sections, so the descriptions form a single
  // aligned edge rather than restarting per heading.
  const width = column(live.flatMap((s) => [...s.commands]));

  const blocks = live.map((s) => {
    const rows = s.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.description}`);
    return `${s.title}\n${rows.join("\n")}`;
  });

  return [
    ...blocks,
    // The two things a new user needs that have no other discovery path: there is
    // no autocomplete entry for either, and nothing else mentions them.
    "Also\n" +
      "  @path             attach a file to your message (Tab completes the path)\n" +
      "  Esc               stop what's running",
  ].join("\n\n");
}
