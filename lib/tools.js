/**
 * Pure mapping between dsh tool calls and the ACP tool-call wire surface.
 * Dependency-free for unit testing.
 *
 * @module dsh-acp-paseo/tools
 */
/** Cap for the rendered tool-result text carried in ACP updates. */
export const MAX_TOOL_RESULT_CHARS = 8000;
/** Cap for query-derived search titles. */
export const MAX_SEARCH_TITLE_CHARS = 60;
const TOOL_KIND_BY_NAME = {
    bash: 'execute',
    pwsh: 'execute',
    read: 'read',
    read_image: 'read',
    write: 'edit',
    edit: 'edit',
    str_replace_editor: 'edit',
    glob: 'search',
    grep: 'search',
    web_search: 'fetch',
    web_fetch: 'fetch',
    todo_write: 'think',
};
/**
 * Map a dsh tool name to the ACP tool kind. `subagent`/`subagent_fork`
 * deliberately map to `undefined`: the ACP kind vocabulary has no subagent
 * member, and Paseo renders the tool-card name as `kind ?? title` — sending
 * `think` labels delegation as "Think" instead of "Subagent". Omitted kind
 * falls back to the title (fixed `'Subagent'`).
 */
export function toolKindForName(name) {
    if (name === 'subagent' || name === 'subagent_fork')
        return undefined;
    return TOOL_KIND_BY_NAME[name] ?? 'other';
}
/** Parse a tool-call arguments JSON string; unparseable input returns the raw string. */
export function parseToolArguments(argumentsJson) {
    try {
        return JSON.parse(argumentsJson);
    }
    catch {
        return argumentsJson;
    }
}
/** Read a string field from an unknown record, safely. */
function readStringField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const field = value[key];
    return typeof field === 'string' ? field : undefined;
}
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/**
 * Derive a human-friendly tool title: the actual command for shells, the
 * target path for file tools, the prompt head for subagent launches, the
 * query for web search — falling back to the tool name when the arguments
 * cannot be read.
 */
export function toolTitleFor(name, argumentsJson) {
    const args = parseToolArguments(argumentsJson);
    switch (name) {
        case 'bash':
        case 'pwsh': {
            const command = readStringField(args, 'command');
            return command !== undefined ? truncate(command, 120) : name;
        }
        case 'read':
        case 'write':
        case 'edit':
        case 'str_replace_editor':
        case 'read_image': {
            const path = readStringField(args, 'path') ?? readStringField(args, 'file_path');
            return path !== undefined ? path : name;
        }
        case 'subagent':
        case 'subagent_fork':
            // Fixed label: Paseo renders the tool-card name from the title when
            // the kind is omitted, so "Subagent" is what the user sees.
            return 'Subagent';
        case 'web_search': {
            const query = readStringField(args, 'query');
            return query !== undefined ? truncate(query, MAX_SEARCH_TITLE_CHARS) : name;
        }
        default:
            return name;
    }
}
/**
 * Extract displayable text from a tool result's content blocks, capped at
 * {@link MAX_TOOL_RESULT_CHARS}. Text blocks concatenate; reasoning is
 * dropped (the subagent's reasoning is not surfaced through the parent).
 */
export function renderToolResultText(blocks) {
    const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
        .map((block) => block.text)
        .join('\n');
    return truncate(text, MAX_TOOL_RESULT_CHARS);
}
