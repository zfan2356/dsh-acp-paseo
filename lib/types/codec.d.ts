/**
 * Pure translation between the dsh session lifecycle and the ACP wire.
 * Everything here is dependency-free and unit-tested in isolation.
 *
 * @module dsh-acp-paseo/codec
 */
/** dsh turn-end reason kinds the bridge observes (structural mirror of TurnEndReason). */
export interface TurnEndReasonLike {
    readonly kind: string;
}
/** ACP prompt content block, structural mirror of the wire union. */
export interface PromptBlockLike {
    readonly type: string;
    readonly text?: string | null;
    readonly name?: string | null;
    readonly uri?: string | null;
}
/** ACP stop reasons the bridge ever emits. */
export type StopReason = 'end_turn' | 'max_tokens' | 'cancelled';
/**
 * Map a dsh turn ending to ACP's terminal reason vocabulary.
 * Hook/other-owner aborts and blocked/error endings are ordinary quiescence,
 * not prompt-level failures; `interrupted` is reserved for explicit client
 * cancellation and disposal.
 */
export declare function turnEndToStopReason(reason: TurnEndReasonLike): StopReason;
/**
 * Flatten ACP prompt blocks to text. Text blocks concatenate verbatim;
 * resource links become explicit bracketed references so the context is never
 * silently dropped.
 */
export declare function acpPromptToText(prompt: readonly PromptBlockLike[]): string;
/**
 * Whether a prompt carries content beyond the ACP baseline (text +
 * resource_link). Richer inline payloads are rejected, never silently dropped.
 */
export declare function promptHasUnsupportedContent(prompt: readonly PromptBlockLike[]): boolean;
/**
 * The command name of a slash line (`/goal set objective` → `goal`); undefined
 * when the line is not a command, so absolute paths like `/mnt/data/x` are
 * ordinary messages rather than commands.
 */
export declare function slashCommandName(line: string): string | undefined;
/**
 * Command Passthrough predicate: a prompt is a slash command exactly when it is
 * one single text block whose content is a well-formed command line (after
 * trimming surrounding whitespace) that the session's registry knows. Any other
 * shape — multiple blocks, resource links, ordinary prose, a leading absolute
 * path — is a normal model message.
 *
 * @param prompt - ACP prompt blocks.
 * @param isRegistered - whether the session exposes that command name; omitted
 *   means every well-formed command line counts as a command.
 * @returns the command line to hand to the dsh command registry, or undefined.
 */
export declare function extractSlashCommand(
    prompt: readonly PromptBlockLike[],
    isRegistered?: (name: string) => boolean,
): string | undefined;
