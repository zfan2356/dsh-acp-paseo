/**
 * Pure translation between the dsh session lifecycle and the ACP wire.
 * Everything here is dependency-free and unit-tested in isolation.
 *
 * @module dsh-acp-paseo/codec
 */
/**
 * Map a dsh turn ending to ACP's terminal reason vocabulary.
 * Hook/other-owner aborts and blocked/error endings are ordinary quiescence,
 * not prompt-level failures; `interrupted` is reserved for explicit client
 * cancellation and disposal.
 */
export function turnEndToStopReason(reason) {
    switch (reason.kind) {
        case 'completed':
            return 'end_turn';
        case 'max-tokens':
            return 'max_tokens';
        case 'interrupted':
            return 'cancelled';
        case 'aborted':
        case 'blocked':
        case 'error':
        default:
            return 'end_turn';
    }
}
/**
 * Flatten ACP prompt blocks to text. Text blocks concatenate verbatim;
 * resource links become explicit bracketed references so the context is never
 * silently dropped. Images are carried as dsh blocks by the caller, not here.
 */
export function acpPromptToText(prompt) {
    return prompt
        .flatMap((block) => {
        switch (block.type) {
            case 'text':
                return [block.text ?? ''];
            case 'resource_link':
                return [`\n[resource_link name=${JSON.stringify(block.name ?? '')} uri=${JSON.stringify(block.uri ?? '')}]\n`];
            default:
                return [];
        }
    })
        .join('');
}
/**
 * Whether a prompt carries content beyond the supported ACP set (text,
 * resource_link, image). Richer inline payloads are rejected, never silently
 * dropped.
 */
export function promptHasUnsupportedContent(prompt) {
    return prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link' && block.type !== 'image');
}
/**
 * The command name of a slash line (`/goal set objective` → `goal`); undefined
 * when the line is not a command, so absolute paths like `/mnt/data/x` are
 * ordinary messages rather than commands. Mirrors the dsh registry's grammar.
 */
export function slashCommandName(line) {
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\s])/u.exec(line);
    return match?.[1];
}
/**
 * Command Passthrough predicate: a prompt is a slash command exactly when it is
 * one single text block whose content is a well-formed command line (after
 * trimming surrounding whitespace) that the session's registry knows. Any other
 * shape — multiple blocks, resource links, ordinary prose, a leading absolute
 * path — is a normal model message.
 *
 * An unknown name is a message too: over ACP there is no composer menu to
 * correct it, and a path like `/tmp` must never fail the prompt with -32602.
 *
 * @param prompt - ACP prompt blocks.
 * @param isRegistered - whether the session exposes that command name; omitted
 *   means every well-formed command line counts as a command.
 * @returns the command line to hand to the dsh command registry, or undefined.
 */
export function extractSlashCommand(prompt, isRegistered) {
    if (prompt.length !== 1)
        return undefined;
    const block = prompt[0];
    if (block === undefined || block.type !== 'text' || typeof block.text !== 'string')
        return undefined;
    const line = block.text.trim();
    const name = slashCommandName(line);
    if (name === undefined)
        return undefined;
    if (isRegistered !== undefined && !isRegistered(name))
        return undefined;
    return line;
}
