/**
 * PromptInput — the chat input box, pinned to the bottom of the screen.
 *
 * Owns its buffer + cursor via useInput (Ink does the word-wrapping; the box
 * grows downward). Beyond plain editing it provides the "real tool" niceties:
 *
 *  - Input history: ↑/↓ walk previously sent messages (a draft is preserved).
 *  - Slash autocomplete: typing `/…` opens a menu of matching commands/skills;
 *    ↑/↓ select, Tab completes, Enter runs the highlighted one.
 *  - Multiline: Shift+Enter inserts a newline (where the terminal reports it);
 *    Enter sends.
 *
 * The transcript above lives in <Static> (see App), so it scrolls naturally and
 * this box stays put. Editing keys: ←/→, Ctrl+A/E (home/end), Ctrl+U (kill line),
 * Backspace, and paste (inserted at the cursor).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { feedPasteChunk, initPasteState, type PasteState } from "../pasteAssembler.js";

/** One autocomplete entry. */
export interface Completion {
  name: string; // includes the leading slash, e.g. "/skills"
  description: string;
}

// A paste collapses to a `[Pasted text …]` chip (the full content is restored when
// the message is sent) once it's big enough to flood the box — either many lines OR
// a long chunk that happens to be few lines (e.g. a couple of wrapped paragraphs).
// A single terminal paste always arrives as one `input` chunk, so a chunk this large
// is unambiguously a paste, never typed keys.
const PASTE_MIN_LINES = 6;
const PASTE_MIN_CHARS = 400;
// Bracketed paste: we ask the terminal (via `\x1b[?2004h`) to wrap every paste in
// `\x1b[200~ … \x1b[201~` markers, so we know exactly where a paste starts and ends
// instead of guessing. The chunk-reassembly state machine lives in pasteAssembler.ts
// (pure + unit-tested); here we just drive it and handle the timing fallback.
const BRACKET_PASTE_ON = "\x1b[?2004h";
const BRACKET_PASTE_OFF = "\x1b[?2004l";
// Safety net if the closing marker is lost or split across a chunk boundary: flush a
// marker-started paste after this much silence. Chunks of one paste arrive microseconds
// apart, so this never fires mid-paste.
const PASTE_END_TIMEOUT_MS = 250;
// Fallback for terminals that DON'T support bracketed paste (no markers ever arrive):
// coalesce chunks by timing. An input event this large, or one with a newline, or a
// continuation of one already buffering, is a paste chunk — never a typed key.
const PASTE_COALESCE_MS = 30;
const PASTE_CHUNK_MIN = 40;

/**
 * The whole input buffer in one state object. Ink runs React in LegacyRoot mode, so
 * state updates from `useInput` (a Node stdin `data` listener, outside React's
 * batching scope) are NOT batched — each separate `setState` flushes its own
 * synchronous render and full terminal redraw. Folding every keystroke into ONE
 * reducer dispatch keeps it at one render → one frame per key, which is what makes
 * typing feel instant instead of laggy (especially on Windows, where each redraw is
 * comparatively expensive).
 */
interface InputState {
  value: string;
  cursor: number; // offset into `value`
  histIdx: number | null; // null = editing a fresh draft (not browsing history)
  selected: number; // highlighted suggestion in the menu
  draft: string; // the in-progress line, stashed while browsing history
}

const INITIAL: InputState = { value: "", cursor: 0, histIdx: null, selected: 0, draft: "" };

type Action =
  | { t: "insert"; text: string } // a keypress or pasted chunk at the cursor
  | { t: "backspace" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "killLine" } // Ctrl+U — delete from start to cursor
  | { t: "newline" } // Shift/Meta+Enter
  | { t: "splice"; start: number; end: number; text: string } // replace a range (path completion)
  | { t: "selUp" }
  | { t: "selDown"; max: number }
  | { t: "histReplace"; value: string; histIdx: number | null; draft?: string }
  | { t: "reset" };

function reduce(s: InputState, a: Action): InputState {
  switch (a.t) {
    case "insert":
      // Typing leaves history-browsing and resets the suggestion highlight.
      return {
        ...s,
        value: s.value.slice(0, s.cursor) + a.text + s.value.slice(s.cursor),
        cursor: s.cursor + a.text.length,
        histIdx: null,
        selected: 0,
      };
    case "backspace":
      if (s.cursor === 0) return s;
      return {
        ...s,
        value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor),
        cursor: s.cursor - 1,
        selected: 0,
      };
    case "left":
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case "right":
      return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
    case "home":
      return { ...s, cursor: 0 };
    case "end":
      return { ...s, cursor: s.value.length };
    case "killLine":
      return { ...s, value: s.value.slice(s.cursor), cursor: 0 };
    case "newline":
      return {
        ...s,
        value: s.value.slice(0, s.cursor) + "\n" + s.value.slice(s.cursor),
        cursor: s.cursor + 1,
      };
    case "splice": {
      const value = s.value.slice(0, a.start) + a.text + s.value.slice(a.end);
      return { ...s, value, cursor: a.start + a.text.length, selected: 0 };
    }
    case "selUp":
      return { ...s, selected: Math.max(0, s.selected - 1) };
    case "selDown":
      return { ...s, selected: Math.min(a.max, s.selected + 1) };
    case "histReplace":
      return {
        ...s,
        value: a.value,
        cursor: a.value.length,
        histIdx: a.histIdx,
        draft: a.draft ?? s.draft,
      };
    case "reset":
      return INITIAL;
  }
}

interface PromptInputProps {
  /** Called with the trimmed text when the user sends (Enter). */
  onSubmit: (value: string) => void;
  /** When true, the box is shown but input is inert (Mindweave is working). */
  disabled?: boolean;
  placeholder?: string;
  /** Current terminal width — used to bound the field so text wraps cleanly. */
  width: number;
  /** Previously sent messages, oldest-first — walked with ↑/↓. */
  history?: string[];
  /** Slash-command / skill completions offered when the buffer starts with `/`. */
  completions?: Completion[];
  /** Resolve a `@path` prefix to candidate paths (dirs end with `/`). Enables the
   *  file picker that opens while typing an `@mention`. */
  pathComplete?: (prefix: string) => Promise<string[]>;
  /** Register a large multi-line paste; returns the placeholder chip to insert in
   *  its place (the App restores the full text when the message is sent). */
  onLargePaste?: (content: string) => string;
}

const MAX_SUGGESTIONS = 8;

export function PromptInput({
  onSubmit,
  disabled = false,
  placeholder = "",
  width,
  history = [],
  completions = [],
  pathComplete,
  onLargePaste,
}: PromptInputProps) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const { value, cursor, histIdx, selected, draft } = state;

  // The two autocomplete sources. Command menu: a single `/token` (no space) at the
  // start. Path menu: a `@token` ending at the cursor, resolved against the
  // filesystem (async, in the effect below). Command takes priority.
  const commandMode = value.startsWith("/") && !value.includes(" ");
  const at = !commandMode && pathComplete ? atTokenAt(value, cursor) : null;
  const [pathItems, setPathItems] = useState<string[]>([]);
  useEffect(() => {
    if (!at || !pathComplete) {
      setPathItems([]);
      return;
    }
    let cancelled = false;
    pathComplete(at.text.slice(1)).then((items) => {
      if (!cancelled) setPathItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [at?.text, pathComplete]);

  const menu = computeMenu();
  const menuOpen = menu !== null;
  const sel = Math.min(selected, Math.max(0, (menu?.items.length ?? 1) - 1));

  function computeMenu(): { mode: "command" | "path"; items: Completion[]; start: number } | null {
    if (commandMode) {
      const items = completions.filter((c) => c.name.toLowerCase().startsWith(value.toLowerCase()));
      return items.length > 0 ? { mode: "command", items, start: 0 } : null;
    }
    if (at && pathItems.length > 0) {
      return { mode: "path", items: pathItems.map((p) => ({ name: "@" + p, description: "" })), start: at.start };
    }
    return null;
  }

  // Apply the highlighted path completion: splice it over the `@token` (keep the
  // menu open after a directory so you can keep drilling in).
  function completePath() {
    if (!menu || menu.mode !== "path") return;
    const chosen = menu.items[sel]!.name;
    const text = chosen.endsWith("/") ? chosen : chosen + " ";
    dispatch({ t: "splice", start: menu.start, end: cursor, text });
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    dispatch({ t: "reset" });
    onSubmit(trimmed);
  }

  // Paste reassembly: a paste arrives as several `input` chunks. `paste` holds the
  // cross-chunk state (see pasteAssembler.ts); the timer flushes the fallback path and
  // guards against a lost end marker.
  const paste = useRef<PasteState>(initPasteState());
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Insert an assembled paste — as a `[Pasted text …]` chip when it's big enough to
  // flood the box, otherwise inline.
  function emitPaste(text: string) {
    if (!text) return;
    const big = text.split("\n").length >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
    dispatch({ t: "insert", text: onLargePaste && big ? onLargePaste(text) : text });
  }
  function flushPaste() {
    pasteTimer.current = null;
    // A split end-marker can leave a stray trailing ESC; drop it.
    const buf = paste.current.buf.replace(/\x1b$/, "");
    paste.current = initPasteState();
    emitPaste(buf);
  }
  // Turn bracketed paste on so the terminal delimits pastes for us; restore it on exit.
  useEffect(() => {
    process.stdout.write(BRACKET_PASTE_ON);
    return () => {
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      process.stdout.write(BRACKET_PASTE_OFF);
    };
  }, []);

  useInput(
    (input, key) => {
      // Bracketed paste (authoritative): from the `\x1b[200~` start marker to the
      // `\x1b[201~` end marker, every chunk is literal pasted content — never Enter,
      // arrows, or other keys — so we handle it here, before anything else, accumulating
      // across chunks. The paste flushes as ONE unit (one chip) at the end marker; the
      // timer only guards against a lost/split end marker.
      const step = feedPasteChunk(paste.current, input);
      if (step.kind !== "passthrough") {
        if (pasteTimer.current) clearTimeout(pasteTimer.current);
        if (step.kind === "flush") {
          pasteTimer.current = null;
          paste.current = initPasteState();
          emitPaste(step.text);
        } else {
          paste.current = step.state;
          pasteTimer.current = setTimeout(flushPaste, PASTE_END_TIMEOUT_MS);
        }
        return;
      }

      // Enter: Shift+Enter inserts a newline (terminals that report it); plain
      // Enter sends — the highlighted suggestion when the menu is open, else the
      // buffer.
      if (key.return) {
        if (key.shift || key.meta) {
          dispatch({ t: "newline" });
          return;
        }
        // In the path menu, Enter completes the path (you press Enter again to send);
        // in the command menu it runs the highlighted command; otherwise it sends.
        if (menu?.mode === "path") {
          completePath();
          return;
        }
        submit(menu ? menu.items[sel]!.name : value);
        return;
      }

      // Tab completes the highlighted suggestion (a command, or a path mention).
      // Shift-Tab is reserved for cycling the interaction mode (handled in App), so
      // it must never complete here.
      if (key.tab && !key.shift && menu) {
        if (menu.mode === "path") completePath();
        else dispatch({ t: "histReplace", value: menu.items[sel]!.name + " ", histIdx: null });
        return;
      }

      // ↑/↓: navigate the menu when open, otherwise walk input history.
      if (key.upArrow) {
        if (menuOpen) dispatch({ t: "selUp" });
        else historyPrev();
        return;
      }
      if (key.downArrow) {
        if (menuOpen) dispatch({ t: "selDown", max: menu!.items.length - 1 });
        else historyNext();
        return;
      }

      if (key.backspace || key.delete) {
        dispatch({ t: "backspace" });
        return;
      }
      if (key.leftArrow) {
        dispatch({ t: "left" });
        return;
      }
      if (key.rightArrow) {
        dispatch({ t: "right" });
        return;
      }
      if (key.ctrl && input === "a") {
        dispatch({ t: "home" });
        return;
      }
      if (key.ctrl && input === "e") {
        dispatch({ t: "end" });
        return;
      }
      if (key.ctrl && input === "u") {
        dispatch({ t: "killLine" });
        return;
      }

      // Ignore control chords / keys we don't handle here (Esc is App's interrupt).
      if (key.ctrl || key.meta || key.escape || key.tab) {
        return;
      }

      // Printable text. On terminals WITHOUT bracketed paste (no markers ever arrive),
      // we fall back to timing: a large chunk, a chunk with a newline, or a continuation
      // of one already buffering is a paste — accumulate and flush once idle so the whole
      // paste is one decision (one chip). A lone keypress inserts immediately.
      if (input) {
        const isPasteChunk =
          paste.current.buf.length > 0 || input.length >= PASTE_CHUNK_MIN || input.includes("\n");
        if (isPasteChunk) {
          paste.current.buf += input;
          if (pasteTimer.current) clearTimeout(pasteTimer.current);
          pasteTimer.current = setTimeout(flushPaste, PASTE_COALESCE_MS);
        } else {
          dispatch({ t: "insert", text: input });
        }
      }

      function historyPrev() {
        if (history.length === 0) return;
        if (histIdx === null) {
          const i = history.length - 1;
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i, draft: value });
        } else if (histIdx > 0) {
          dispatch({ t: "histReplace", value: history[histIdx - 1]!, histIdx: histIdx - 1 });
        }
      }
      function historyNext() {
        if (histIdx === null) return;
        const i = histIdx + 1;
        if (i >= history.length) {
          dispatch({ t: "histReplace", value: draft, histIdx: null });
        } else {
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i });
        }
      }
    },
    { isActive: !disabled },
  );

  const fieldWidth = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        width={width}
        borderStyle="single"
        borderColor="gray"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Box>
          <Text bold color="cyan">{"> "}</Text>
          <Box width={fieldWidth}>
            <Field value={value} cursor={cursor} active={!disabled} placeholder={placeholder} />
          </Box>
        </Box>
      </Box>

      {menu ? <SuggestionMenu matches={menu.items} selected={sel} width={width} /> : null}
    </Box>
  );
}

/** The `@token` ending at the cursor (back to the nearest whitespace), or null.
 *  Used to drive the file-path picker while typing a `@mention`. */
function atTokenAt(value: string, cursor: number): { text: string; start: number } | null {
  let i = cursor;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  const text = value.slice(i, cursor);
  return text.startsWith("@") ? { text, start: i } : null;
}

/**
 * The dropdown of matching commands/skills shown below the input. It SCROLLS: a
 * sliding window keeps the highlighted row in view as ↑/↓ move past the visible
 * count, with `↑ N more` / `↓ N more` markers for what's hidden above/below — so a
 * long list (every command) is fully reachable, not capped at the first few.
 */
function SuggestionMenu({
  matches,
  selected,
  width,
}: {
  matches: Completion[];
  selected: number;
  width: number;
}) {
  // Window the list so `selected` is always visible (same scheme as Picker).
  const start = Math.min(Math.max(0, selected - (MAX_SUGGESTIONS - 1)), Math.max(0, matches.length - MAX_SUGGESTIONS));
  const shown = matches.slice(start, start + MAX_SUGGESTIONS);
  const nameWidth = Math.min(18, Math.max(...shown.map((m) => m.name.length), 1));
  const above = start;
  const below = matches.length - (start + shown.length);
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
      {shown.map((m, i) => {
        const active = start + i === selected;
        return (
          <Box key={m.name} width={width - 2}>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "› " : "  "}
              {m.name.padEnd(nameWidth)}
            </Text>
            <Text dimColor wrap="truncate-end">{"  " + m.description}</Text>
          </Box>
        );
      })}
      {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
    </Box>
  );
}

/** The text area: the buffer word-wrapped, with a block cursor, or a placeholder. */
function Field({
  value,
  cursor,
  active,
  placeholder,
}: {
  value: string;
  cursor: number;
  active: boolean;
  placeholder: string;
}) {
  if (value.length === 0) {
    return (
      <Text wrap="truncate-end">
        {active ? <Text inverse> </Text> : null}
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  if (!active) {
    return <Text wrap="wrap">{value}</Text>;
  }

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);
  return (
    <Text wrap="wrap">
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
