/**
 * Pure mapping between dsh tool calls and the ACP tool-call wire surface.
 * Dependency-free for unit testing.
 *
 * @module dsh-acp-paseo/tools
 */
/** ACP tool kinds the bridge emits (structural mirror of the wire union). */
export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
/** Cap for the rendered tool-result text carried in ACP updates. */
export declare const MAX_TOOL_RESULT_CHARS = 8000;
/** Cap for query-derived search titles. */
export declare const MAX_SEARCH_TITLE_CHARS = 60;
/**
 * Map a dsh tool name to the ACP tool kind. `subagent`/`subagent_fork`
 * deliberately map to `undefined`: the ACP kind vocabulary has no subagent
 * member, and Paseo renders the tool-card name as `kind ?? title` — sending
 * `think` labels delegation as "Think" instead of "Subagent". Omitted kind
 * falls back to the title (fixed `'Subagent'`).
 */
export declare function toolKindForName(name: string): AcpToolKind | undefined;
/** Parse a tool-call arguments JSON string; unparseable input returns the raw string. */
export declare function parseToolArguments(argumentsJson: string): unknown;
/**
 * Derive a human-friendly tool title: the actual command for shells, the
 * target path for file tools, the prompt head for subagent launches, the
 * query for web search — falling back to the tool name when the arguments
 * cannot be read.
 */
export declare function toolTitleFor(name: string, argumentsJson: string): string;
/**
 * Extract displayable text from a tool result's content blocks, capped at
 * {@link MAX_TOOL_RESULT_CHARS}. Text blocks concatenate; reasoning is
 * dropped (the subagent's reasoning is not surfaced through the parent).
 */
export declare function renderToolResultText(blocks: readonly {
    readonly type: string;
    readonly text?: string;
}[]): string;
