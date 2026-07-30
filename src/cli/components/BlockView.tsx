/**
 * BlockView — render one transcript block, the same whether committed (in
 * <Static> scrollback) or live in the tail. Gutter-aligned: the
 * first row of every block is a single marker in a 2-col gutter, the content
 * breathing beside it and wrapped lines hanging under the content.
 */
import { Box, Text } from "ink";
import { renderMarkdown } from "../markdown.js";
import { ToolLine } from "./ToolLine.js";
import { ToolGroup } from "./ToolGroup.js";
import { SubagentView } from "./SubagentView.js";
import type { Block } from "../transcript.js";

export function BlockView({ block, columns, tightTop }: { block: Block; columns: number; tightTop?: boolean }) {
  const textWidth = Math.max(8, columns - 4);

  switch (block.kind) {
    case "user":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text color="cyan">{">"}</Text></Box>
          <Box width={textWidth}><Text color="cyan" wrap="wrap">{block.text}</Text></Box>
        </Box>
      );

    case "assistant":
      if (!block.text) return null;
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text>{"●"}</Text></Box>
          <Box width={textWidth} flexDirection="column">
            <Text wrap="wrap">{renderMarkdown(block.text, textWidth)}</Text>
          </Box>
        </Box>
      );

    case "tool":
      return (
        <ToolLine
          name={block.name}
          arg={block.arg}
          status={block.status}
          action={block.action}
          summary={block.summary}
          detail={block.detail}
          columns={columns}
          tightTop={tightTop}
        />
      );

    case "tools":
      return <ToolGroup items={block.items} done={block.done} columns={columns} tightTop={tightTop} />;

    case "subagent":
      return (
        <SubagentView
          task={block.task}
          readOnly={block.readOnly}
          status={block.status}
          summary={block.summary}
          items={block.items}
          done={block.done}
          columns={columns}
          tightTop={tightTop}
        />
      );

    case "error":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text color="red">{"●"}</Text></Box>
          <Box width={textWidth}><Text color="red" wrap="wrap">{block.text}</Text></Box>
        </Box>
      );

    case "completion":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text dimColor>{"✻"}</Text></Box>
          <Text dimColor>{block.text}</Text>
        </Box>
      );

    case "note":
      return (
        <Box width={columns}>
          <Text dimColor wrap="wrap">{"· "}{block.text}</Text>
        </Box>
      );

    case "context":
      // Context trimming (compaction) — set off from ordinary activity with its own
      // faint marker and italics, so it reads as housekeeping, not something Mindweave did.
      return (
        <Box marginTop={1} marginBottom={1} width={columns}>
          <Text dimColor italic wrap="truncate-end">{"⋯ "}{block.text}</Text>
        </Box>
      );
  }
}

