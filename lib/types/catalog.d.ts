/**
 * Pure derivation of the ACP session state surfaces Paseo auto-discovers:
 * model catalog, modes, thought-level config option, and the slash-command
 * list. Structural wire types keep this module dependency-free for tests.
 *
 * @module dsh-acp-paseo/catalog
 */
/** dsh llm catalog entry (structural mirror of LlmModelInfo). */
export interface DshModelInfo {
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** dsh command descriptor (structural mirror of CommandDescriptor). */
export interface DshCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
    };
}
/** dsh reasoning effort metadata (structural mirror of LlmReasoningEffortInfo). */
export interface DshEffortInfo {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
export interface AcpModelInfo {
    readonly modelId: string;
    readonly name: string;
    readonly description?: string;
}
export interface AcpSessionModelState {
    availableModels: AcpModelInfo[];
    currentModelId: string;
}
export interface AcpSessionMode {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
export interface AcpSessionModeState {
    availableModes: AcpSessionMode[];
    currentModeId: string;
}
export interface AcpSelectOption {
    readonly name: string;
    readonly value: string;
    readonly description?: string;
}
export interface AcpSelectConfigOption {
    type: 'select';
    id: string;
    name: string;
    category: string;
    currentValue: string;
    options: AcpSelectOption[];
    description?: string;
}
export interface AcpAvailableCommand {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
    };
}
/** The provider route whose catalog v1 exposes (overridable via plugin config). */
export declare const DEFAULT_CATALOG_PROVIDER = "deepseek-official";
/** Mode ids. `execute` is the default; `plan` mirrors dsh plan mode. */
export declare const MODE_EXECUTE = "execute";
export declare const MODE_PLAN = "plan";
export declare const AVAILABLE_MODES: readonly AcpSessionMode[];
/** Config option identity for the thought-level selector. */
export declare const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export declare const THOUGHT_LEVEL_CATEGORY = "thought_level";
/** Fallback effort ladder when the adapter does not advertise one. */
export declare const FALLBACK_EFFORTS: readonly DshEffortInfo[];
/** Commands that never make sense over a headless ACP transport. */
export declare const DEFAULT_COMMAND_BLOCKLIST: readonly string[];
export declare function isModeId(value: string): value is typeof MODE_EXECUTE | typeof MODE_PLAN;
/** Map a dsh mode boolean (plan active?) to the ACP mode id. */
export declare function modeIdForPlanActive(active: boolean): string;
/** Build the ACP model state from the dsh catalog and the current selection. */
export declare function buildModelState(models: readonly DshModelInfo[], currentModelId: string): AcpSessionModelState;
/** Build the ACP mode state for a session. */
export declare function buildModeState(currentModeId: string): AcpSessionModeState;
/**
 * Normalize the effort ladder: adapter-advertised efforts when present and
 * non-empty, otherwise the fallback off/high/max ladder.
 */
export declare function resolveEfforts(efforts: readonly DshEffortInfo[] | undefined): readonly DshEffortInfo[];
/** Build the thought_level select config option for the session state. */
export declare function buildThoughtLevelOption(currentValue: string, efforts: readonly DshEffortInfo[]): AcpSelectConfigOption;
/** Whether a value is a legal effort id for the session's ladder. */
export declare function isEffortValue(value: string, efforts: readonly DshEffortInfo[]): boolean;
/**
 * Map dsh command descriptors to ACP available commands, dropping blocklisted
 * names (web-only commands that cannot work over a headless transport).
 */
export declare function buildAvailableCommands(descriptors: readonly DshCommandDescriptor[], blocklist: readonly string[]): AcpAvailableCommand[];
