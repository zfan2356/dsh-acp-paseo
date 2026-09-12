/**
 * Pure derivation of the ACP session state surfaces Paseo auto-discovers:
 * model catalog, modes, thought-level config option, and the slash-command
 * list. Structural wire types keep this module dependency-free for tests.
 *
 * @module dsh-acp-paseo/catalog
 */
/** The provider route whose catalog v1 exposes (overridable via plugin config). */
export const DEFAULT_CATALOG_PROVIDER = 'deepseek-official';
/** Mode ids. `execute` is the default; `plan` mirrors dsh plan mode. */
export const MODE_EXECUTE = 'execute';
export const MODE_PLAN = 'plan';
export const AVAILABLE_MODES = [
    {
        id: MODE_EXECUTE,
        name: 'Execute',
        description: 'Normal coding: edits, tool execution, and implementation work',
    },
    {
        id: MODE_PLAN,
        name: 'Plan',
        description: 'Read-only planning; no file edits until the plan is approved',
    },
];
/** Config option identity for the thought-level selector. */
export const THOUGHT_LEVEL_CONFIG_ID = 'thought_level';
export const THOUGHT_LEVEL_CATEGORY = 'thought_level';
/** Fallback effort ladder when the adapter does not advertise one. */
export const FALLBACK_EFFORTS = [
    { id: 'off', name: 'Off', description: 'No extended reasoning' },
    { id: 'high', name: 'High', description: 'Extended reasoning' },
    { id: 'max', name: 'Max', description: 'Maximum reasoning budget' },
];
/** Commands that never make sense over a headless ACP transport. */
export const DEFAULT_COMMAND_BLOCKLIST = ['export'];
export function isModeId(value) {
    return value === MODE_EXECUTE || value === MODE_PLAN;
}
/** Map a dsh mode boolean (plan active?) to the ACP mode id. */
export function modeIdForPlanActive(active) {
    return active ? MODE_PLAN : MODE_EXECUTE;
}
/** Build the ACP model state from the dsh catalog and the current selection. */
export function buildModelState(models, currentModelId) {
    return {
        availableModels: models.map((model) => ({
            modelId: model.id,
            name: model.name,
            ...(model.description !== undefined ? { description: model.description } : {}),
        })),
        currentModelId,
    };
}
/** Build the ACP mode state for a session. */
export function buildModeState(currentModeId) {
    return { availableModes: [...AVAILABLE_MODES], currentModeId };
}
/**
 * Normalize the effort ladder: adapter-advertised efforts when present and
 * non-empty, otherwise the fallback off/high/max ladder.
 */
export function resolveEfforts(efforts) {
    return efforts !== undefined && efforts.length > 0 ? efforts : FALLBACK_EFFORTS;
}
/** Build the thought_level select config option for the session state. */
export function buildThoughtLevelOption(currentValue, efforts) {
    return {
        type: 'select',
        id: THOUGHT_LEVEL_CONFIG_ID,
        name: 'Thinking',
        category: THOUGHT_LEVEL_CATEGORY,
        description: 'Reasoning effort for the DeepSeek model',
        currentValue,
        options: efforts.map((effort) => ({
            name: effort.name,
            value: effort.id,
            ...(effort.description !== undefined ? { description: effort.description } : {}),
        })),
    };
}
/** Whether a value is a legal effort id for the session's ladder. */
export function isEffortValue(value, efforts) {
    return efforts.some((effort) => effort.id === value);
}
/**
 * Map dsh command descriptors to ACP available commands, dropping blocklisted
 * names (web-only commands that cannot work over a headless transport).
 */
export function buildAvailableCommands(descriptors, blocklist) {
    return descriptors
        .filter((descriptor) => !blocklist.includes(descriptor.name))
        .map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        ...(descriptor.input !== undefined ? { input: { hint: descriptor.input.hint } } : {}),
    }));
}
