/**
 * dsh-acp-paseo bridge: an enhanced ACP server mounted inside a dsh profile.
 *
 * On top of the baseline prompt/cancel transport this bridge exposes the
 * surfaces Paseo auto-discovers from `session/new`:
 *
 *   - the model catalog of the `deepseek-official` route (read live from
 *     `ctx.llm`) plus real model switching through `session/set_model`,
 *   - two session modes, `execute` and `plan`, mapped onto the dsh plan-mode
 *     boolean and switched through `session/set_mode`,
 *   - a `thought_level` config option (off/high/max) mapped onto the dsh
 *     `reasoningEffort`, switched through `session/set_config_option`,
 *   - the dsh slash-command registry, broadcast as
 *     `available_commands_update` and executed in-prompt (Command
 *     Passthrough), never sent to the model,
 *   - image prompts (screenshots), admitted into the durable attachment store
 *     and carried as ordered dsh image blocks,
 *   - conversation replay on attach (`session/load`), so a client that keeps no
 *     timeline of its own still opens a persisted session with its history.
 *
 * Sessions are connection-owned, mirroring the official automation bridge's
 * lifetime model; a persisted session is re-attached and replayed on demand.
 *
 * @module dsh-acp-paseo
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import Schema from '@deepseek-ai/schemastery';
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream, } from '@agentclientprotocol/sdk';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { admitEncodedImages, isImageAdmissionError } from '@deepseek-ai/dsh-attachment';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-user-approval';
import '@deepseek-ai/dsh-plan-mode';
import '@deepseek-ai/dsh-commands';
import '@deepseek-ai/dsh-agent-default-model';
import { acpPromptToText, extractSlashCommand, promptHasUnsupportedContent, slashCommandName, turnEndToStopReason, } from "./codec.js";
import { DEFAULT_CATALOG_PROVIDER, DEFAULT_COMMAND_BLOCKLIST, MODE_EXECUTE, MODE_PLAN, THOUGHT_LEVEL_CONFIG_ID, buildAvailableCommands, buildModeState, buildModelState, buildThoughtLevelOption, isEffortValue, isModeId, modeIdForPlanActive, resolveEfforts, } from "./catalog.js";
import { parseToolArguments, renderToolResultText, toolKindForName, toolTitleFor, } from "./tools.js";
export const name = 'dsh-acp-paseo';
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ['agents', 'llm', 'commands', 'planMode', 'agentDefaultModel', 'attachments'];
const { version: BRIDGE_VERSION } = readPackageVersion();
function readPackageVersion() {
    try {
        return createRequire(import.meta.url)('../package.json');
    }
    catch {
        return { version: '0.0.0' };
    }
}
export const Config = Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    commandBlocklist: Schema.array(Schema.string()),
});
function invalidParams(detail) {
    return RequestError.invalidParams(undefined, detail);
}
function internalError(detail) {
    return RequestError.internalError(undefined, detail);
}
/**
 * Mount the Paseo-facing ACP bridge.
 * @param ctx - Cordis context of the dsh profile.
 * @param config - Optional provider/model pins, command blocklist, test transport.
 */
export function apply(ctx, config) {
    const agents = ctx.agents;
    const logger = ctx.logger;
    const catalogProvider = config.provider ?? DEFAULT_CATALOG_PROVIDER;
    const blocklist = config.commandBlocklist ?? [...DEFAULT_COMMAND_BLOCKLIST];
    const sessions = new Map();
    /** (sessionId:turn:step) pairs whose deltas were already streamed. */
    const streamedSteps = new Set();
    let closed = false;
    let conn;
    const ownedRecord = (agent) => {
        const record = sessions.get(agent.session.id);
        return record?.agent === agent ? record : undefined;
    };
    const assertOpen = () => {
        if (closed)
            throw internalError('the ACP bridge has been disposed');
    };
    const requireSession = (sessionId) => {
        const record = sessions.get(sessionId);
        if (record === undefined)
            throw invalidParams(`unknown session: ${sessionId}`);
        return record;
    };
    /** Send a protocol update without letting a disconnected client fail an agent turn. */
    const notify = (notification) => {
        conn.sessionUpdate(notification).catch((error) => {
            logger.warn(`acp: session/update failed: ${String(error)}`);
        });
    };
    const notifyText = (record, text, messageId) => {
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
                ...(messageId !== undefined ? { messageId } : {}),
            },
        });
    };
    const notifyThought = (record, text, messageId) => {
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text },
                ...(messageId !== undefined ? { messageId } : {}),
            },
        });
    };
    /**
     * Echo a user turn. Only the history replay sends this: the live path would
     * duplicate the prompt Paseo already recorded when it submitted it.
     */
    const notifyUserMessage = (record, text, messageId) => {
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text },
                ...(messageId !== undefined ? { messageId } : {}),
            },
        });
    };
    const notifyMode = (record, modeId) => {
        notify({
            sessionId: record.agent.session.id,
            update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
        });
    };
    const notifyToolCall = (record, callId, name, argumentsJson) => {
        record.inFlightTools.add(callId);
        const kind = toolKindForName(name);
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: callId,
                title: toolTitleFor(name, argumentsJson),
                ...(kind !== undefined ? { kind } : {}),
                status: 'in_progress',
                rawInput: parseToolArguments(argumentsJson),
            },
        });
    };
    const notifyToolResult = (record, callId, isError, text, errorDetail) => {
        record.inFlightTools.delete(callId);
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: callId,
                status: isError ? 'failed' : 'completed',
                ...(text.length > 0
                    ? { content: [{ type: 'content', content: { type: 'text', text } }] }
                    : {}),
                rawOutput: isError
                    ? { error: { message: errorDetail !== undefined && errorDetail.length > 0 ? errorDetail : 'tool call failed' } }
                    : text.length > 0
                        ? { output: text }
                        : {},
            },
        });
    };
    /** Close every in-flight tool as failed (session cancel or connection teardown). */
    const failInFlightTools = (record) => {
        for (const callId of record.inFlightTools) {
            notify({
                sessionId: record.agent.session.id,
                update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: callId,
                    status: 'failed',
                    rawOutput: { error: { message: 'cancelled' } },
                },
            });
        }
        record.inFlightTools.clear();
    };
    const listCommandsFor = (record) => {
        try {
            return buildAvailableCommands(ctx.commands.list(record.agent), blocklist);
        }
        catch (error) {
            logger.warn(`acp: command listing failed: ${errorChain(error)}`);
            return [];
        }
    };
    /** Push the session's command surface; called at creation and on registry changes. */
    const broadcastCommands = (record) => {
        notify({
            sessionId: record.agent.session.id,
            update: { sessionUpdate: 'available_commands_update', availableCommands: listCommandsFor(record) },
        });
    };
    /**
     * Command broadcasts must NOT be sent before the `session/new` response:
     * Paseo's ACPAgentSession drops any session/update whose sessionId does not
     * yet match its own (it learns the id only from the response), and its
     * message pump handles notifications concurrently with request responses.
     * The client also queries commands once right after session creation with
     * no wait (generic ACP `waitForInitialCommands` is false), so a single
     * post-response broadcast can still race that first query. Re-broadcast on
     * a small ladder after the response: the client's cache fills as soon as
     * one notification lands, and every later `list_commands` query hits it.
     */
    const COMMAND_BROADCAST_DELAYS_MS = [0, 250, 1000];
    const scheduleCommandBroadcast = (record) => {
        for (const delay of COMMAND_BROADCAST_DELAYS_MS) {
            record.broadcastTimers.push(setTimeout(() => {
                if (closed)
                    return;
                broadcastCommands(record);
            }, delay));
        }
    };
    const settlePrompt = (record, reason) => {
        const inflight = record.inflight;
        if (inflight === undefined)
            return;
        record.inflight = undefined;
        inflight.resolve(reason);
    };
    /**
     * Translate one dsh session event into the ACP updates Paseo consumes. The
     * live stream and the history replay share this mapping, so a replayed
     * conversation renders with the same shapes it had while it was live.
     *
     * Assistant chunks carry the dsh message id: Paseo groups a message's chunks
     * by `messageId`, and an explicit id keeps a step's text and reasoning in one
     * item without relying on its fallback-id heuristic.
     */
    const translateSessionEvent = (record, event) => {
        if (event.type === 'assistant/chunk') {
            const chunk = event.data.chunk;
            if (chunk.type === 'reasoning-delta') {
                streamedSteps.add(`${record.agent.session.id}:${event.data.turn}:${event.data.step}`);
                notifyThought(record, chunk.text);
            }
            else if (chunk.type === 'text-delta') {
                streamedSteps.add(`${record.agent.session.id}:${event.data.turn}:${event.data.step}`);
                notifyText(record, chunk.text);
            }
        }
        else if (event.type === 'assistant/message') {
            const key = `${record.agent.session.id}:${event.data.turn}:${event.data.step}`;
            const streamed = streamedSteps.has(key);
            streamedSteps.delete(key);
            const messageId = event.data.message.id;
            for (const block of event.data.message.content) {
                if (block.type === 'text' && !streamed && block.text.length > 0)
                    notifyText(record, block.text, messageId);
                else if (block.type === 'reasoning' && !streamed && block.text.length > 0)
                    notifyThought(record, block.text, messageId);
                else if (block.type === 'image') {
                    notifyText(record, `[image attachment ${block.attachment.attachmentId}]`, messageId);
                }
            }
        }
        else if (event.type === 'tool/call') {
            notifyToolCall(record, event.data.callId, event.data.name, event.data.arguments);
        }
        else if (event.type === 'tool/result') {
            const resultBlock = event.data.message.content[0];
            const isError = resultBlock?.isError === true;
            const text = renderToolResultText(resultBlock?.content ?? []);
            const errorDetail = event.data.error !== undefined ? `${event.data.error.name}: ${event.data.error.code}` : undefined;
            if (resultBlock?.toolCallId !== undefined) {
                notifyToolResult(record, resultBlock.toolCallId, isError, text, errorDetail);
            }
        }
        else if (event.type === 'plan/mode') {
            notifyMode(record, modeIdForPlanActive(event.data.active));
        }
    };
    /**
     * Re-send a persisted conversation as ACP updates (ACP `session/load`).
     *
     * Paseo keeps timelines in daemon memory, so after a daemon restart the only
     * surviving copy of a dsh conversation is the session's own event log. A
     * bridge that attaches without replaying it leaves the chat empty.
     *
     * Only the events that close a message are replayed: `assistant/chunk` deltas
     * are dropped because the `assistant/message` that ends the step carries the
     * same text in full, and dsh writes both to the log. Tool calls arrive as
     * their own `tool/call` / `tool/result` pairs, exactly as they do live.
     */
    const replayTranscript = (record, events) => {
        for (const event of events) {
            // The live path never echoes the user's own prompt (Paseo records it
            // on submit); a replay has no such record, so user turns are sent here.
            if (event.type === 'user/message') {
                const text = userMessageText(event.data);
                if (text.length > 0)
                    notifyUserMessage(record, text, event.data.id);
                continue;
            }
            if (event.type === 'assistant/chunk')
                continue;
            translateSessionEvent(record, event);
        }
    };
    ctx.on('session/event', (session, event) => {
        const record = sessions.get(session.header.id);
        if (record === undefined || record.agent.session !== session)
            return;
        try {
            translateSessionEvent(record, event);
        }
        finally {
            const inflight = record.inflight;
            if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
                if (event.data.reason.kind === 'error') {
                    record.inflight = undefined;
                    inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`));
                }
                else
                    inflight.endReason = event.data.reason;
            }
        }
    });
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const inflight = ownedRecord(agent)?.inflight;
        if (inflight !== undefined && inflight.messageId === message.id)
            inflight.turn = turn;
    });
    ctx.on('agent/error', ({ agent, turn, error }) => {
        const record = ownedRecord(agent);
        const inflight = record?.inflight;
        if (record === undefined || inflight === undefined || inflight.turn === turn)
            return;
        record.inflight = undefined;
        inflight.reject(internalError(`turn failed: ${errorChain(error)}`));
    });
    ctx.on('approval/request', (request, next) => {
        const record = ownedRecord(request.agent);
        if (record === undefined || request.callId === undefined)
            return next();
        return conn
            .requestPermission({
            sessionId: record.agent.session.id,
            toolCall: { toolCallId: request.callId },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
        })
            .then(({ outcome }) => {
            if (outcome.outcome === 'cancelled')
                return 'cancelled';
            return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected';
        });
    });
    ctx.on('commands/change', () => {
        for (const record of sessions.values())
            broadcastCommands(record);
    });
    /**
     * Execute one slash command line through the dsh registry. A known command's
     * error result is rendered as agent text, and a command that starts a turn
     * (e.g. `/plan <message>`) keeps the ACP turn open until the agent is idle
     * again; the caller only routes registered names here.
     */
    const runSlashCommand = async (record, line) => {
        if (ctx.agents.get(record.agent.id) !== record.agent) {
            throw internalError('command was not executed: the agent was disposed outside the bridge');
        }
        const abort = new AbortController();
        record.commandAbort = abort;
        try {
            // rc.8 registry order is (agent, line, images, signal); passing the
            // signal as `images` left invocation.signal undefined and every
            // command died with "reading 'aborted'".
            const execution = await ctx.commands.execute(record.agent, line, [], abort.signal);
            if (execution === undefined) {
                throw invalidParams(`unknown command: /${slashCommandName(line) ?? line.trim()}`);
            }
            const text = execution.result.text;
            if (text !== undefined && text.length > 0)
                notifyText(record, text);
            await record.agent.whenIdle();
            return abort.signal.aborted ? 'cancelled' : 'end_turn';
        }
        catch (error) {
            if (abort.signal.aborted)
                return 'cancelled';
            if (error instanceof RequestError)
                throw error;
            throw internalError(`command failed: ${errorChain(error)}`);
        }
        finally {
            if (record.commandAbort === abort)
                record.commandAbort = undefined;
        }
    };
    /** Resolve the session's effort ladder and default effort from the adapter. */
    const resolveSessionEfforts = async (model) => {
        try {
            const resolved = await ctx.llm.resolveModelInfo(catalogProvider, model);
            return {
                efforts: resolveEfforts(resolved.reasoning?.efforts),
                defaultEffort: resolved.reasoning?.defaultEffort,
            };
        }
        catch (error) {
            logger.warn(`acp: reasoning effort discovery failed: ${errorChain(error)}`);
            return { efforts: resolveEfforts(undefined), defaultEffort: undefined };
        }
    };
    /**
     * Whether the session's selected model advertises image input. Discovery
     * failure stays permissive: the request path already rejects text-only
     * models, and a bridge-side guess must not block a capable one.
     */
    const sessionAcceptsImages = async (record) => {
        const current = record.selection.current;
        if (current === undefined)
            return true;
        try {
            const resolved = await ctx.llm.resolveModelInfo(current.provider ?? catalogProvider, current.model);
            return resolved.inputModalities === undefined || resolved.inputModalities.includes('image');
        }
        catch (error) {
            logger.warn(`acp: image modality discovery failed: ${errorChain(error)}`);
            return true;
        }
    };
    /** Publish a created or resumed dsh agent as an ACP session in this bridge. */
    const publishSession = async (handle, sessionId, sourceSelection) => {
        if (closed) {
            await handle.dispose();
            throw internalError('connection closed while publishing a session');
        }
        const agent = handle.agent;
        let catalog = [];
        try {
            catalog = await ctx.llm.listModels(catalogProvider);
        }
        catch (error) {
            logger.warn(`acp: model catalog discovery failed: ${errorChain(error)}`);
        }
        const currentModelId = pickCurrentModelId(config, catalogProvider, catalog, sourceSelection);
        const { efforts, defaultEffort } = await resolveSessionEfforts(currentModelId);
        const pinned = config.provider !== undefined || config.model !== undefined;
        const selection = {
            current: {
                ...(pinned
                    ? { provider: config.provider ?? catalogProvider, model: config.model ?? currentModelId }
                    : { ...sourceSelection }),
                reasoningEffort: ReasoningEffortId(sourceSelection.reasoningEffort ?? defaultEffort ?? efforts[0]?.id ?? 'off'),
            },
            assembled: undefined,
        };
        const disposeSelection = installModelSelection(agent.ctx, selection);
        const record = {
            agent,
            dispose: () => handle.dispose(),
            inflight: undefined,
            selection,
            disposeSelection,
            efforts,
            commandAbort: undefined,
            inFlightTools: new Set(),
            broadcastTimers: [],
        };
        sessions.set(sessionId, record);
        scheduleCommandBroadcast(record);
        const effort = selection.current?.reasoningEffort ?? 'off';
        return {
            sessionId,
            models: buildModelState(catalog, currentModelId),
            modes: buildModeState(MODE_EXECUTE),
            configOptions: [buildThoughtLevelOption(effort, efforts)],
        };
    };
    const makeAgent = (connection) => {
        conn = connection;
        return {
            initialize(_params) {
                return Promise.resolve({
                    protocolVersion: PROTOCOL_VERSION,
                    agentInfo: { name: 'dsh-acp-paseo', version: BRIDGE_VERSION },
                    agentCapabilities: {
                        promptCapabilities: { image: true, audio: false, embeddedContext: false },
                        // Paseo takes session/load when it is advertised and falls
                        // back to session/resume otherwise; only load replays the
                        // conversation, so the flag decides whether a resumed chat
                        // opens with its history or empty.
                        loadSession: true,
                        // Paseo drives Side Chat and agent resume through these.
                        sessionCapabilities: { fork: {}, resume: {} },
                    },
                    authMethods: [],
                });
            },
            authenticate(_params) {
                return Promise.resolve();
            },
            async newSession(params) {
                assertOpen();
                validateSessionParams(params);
                const sessionId = SessionId(randomUUID());
                const defaultSelection = ctx.agentDefaultModel.currentSelection();
                const handle = await agents.create({
                    sessionId,
                    meta: { cwd: params.cwd },
                    agentOptions: resolveAgentOptions(config, defaultSelection),
                });
                return publishSession(handle, sessionId, defaultSelection);
            },
            /**
             * Fork a live session into an independent one (ACP `session/fork`) so
             * Paseo can open a Side Chat that carries the parent context without
             * disturbing the parent turn. dsh validates the seed prefix, so an
             * in-flight turn is dropped rather than ending the seed inside it.
             */
            async unstable_forkSession(params) {
                assertOpen();
                validateSessionParams(params);
                const parent = requireSession(params.sessionId);
                const sessionId = SessionId(randomUUID());
                // Read the live session the agent owns; ctx.sessions is not injected here.
                const seed = forkSeedEvents(parent.agent.session.events);
                const handle = await agents.create({
                    sessionId,
                    meta: { cwd: params.cwd, parentSession: params.sessionId, seedLength: seed.length },
                    seed,
                    agentOptions: resolveAgentOptions(config, parent.selection.current),
                });
                return publishSession(handle, sessionId, parent.selection.current);
            },
            /**
             * Attach a fresh bridge process to a persisted session (ACP
             * `session/resume`, no history replay) so a side-chat fork or a
             * restarted daemon continues the same dsh session.
             */
            async unstable_resumeSession(params) {
                assertOpen();
                validateSessionParams(params);
                const sessionId = SessionId(params.sessionId);
                const defaultSelection = ctx.agentDefaultModel.currentSelection();
                const handle = await agents.resume({ resumeSessionId: sessionId });
                return publishSession(handle, sessionId, defaultSelection);
            },
            /**
             * Attach to a persisted session and replay its transcript (ACP
             * `session/load`). Paseo keeps timelines in daemon memory, so after a
             * daemon restart the session's own event log is the only surviving
             * copy of the conversation; a resume without this replay opens the
             * chat empty. Side chats stay clean because Paseo marks their history
             * primed and skips provider hydration.
             */
            async loadSession(params) {
                assertOpen();
                validateSessionParams(params);
                const sessionId = SessionId(params.sessionId);
                const defaultSelection = ctx.agentDefaultModel.currentSelection();
                const handle = await agents.resume({ resumeSessionId: sessionId });
                const response = await publishSession(handle, sessionId, defaultSelection);
                // Send the transcript before this response: Paseo collects the
                // updates it receives while the load request is in flight.
                const record = sessions.get(sessionId);
                if (record !== undefined)
                    replayTranscript(record, record.agent.session.events);
                return response;
            },
            async prompt(params) {
                assertOpen();
                const record = requireSession(params.sessionId);
                if (record.inflight !== undefined)
                    throw invalidParams('a prompt is already in flight for this session');
                if (promptHasUnsupportedContent(params.prompt)) {
                    throw invalidParams('only text, resource_link, and image prompt content is supported');
                }
                const hasImages = params.prompt.some((block) => block.type === 'image');
                if (hasImages && !(await sessionAcceptsImages(record))) {
                    throw invalidParams(`model "${record.selection.current?.model}" does not accept image input`);
                }
                if (!hasImages && acpPromptToText(params.prompt).trim().length === 0)
                    throw invalidParams('empty prompt');
                const commandLine = extractSlashCommand(
                    params.prompt,
                    (name) => ctx.commands.find(record.agent, name) !== undefined,
                );
                if (commandLine !== undefined) {
                    return { stopReason: await runSlashCommand(record, commandLine) };
                }
                if (ctx.agents.get(record.agent.id) !== record.agent) {
                    throw internalError('prompt was not queued: the agent was disposed outside the bridge');
                }
                let content;
                try {
                    content = await toUserContent(ctx.attachments, params.prompt);
                }
                catch (error) {
                    if (isImageAdmissionError(error))
                        throw invalidParams(`prompt image rejected: ${error.message}`);
                    throw internalError(`prompt image could not be stored: ${errorChain(error)}`);
                }
                const message = createUserMessage({
                    content,
                    source: { kind: 'user' },
                });
                return {
                    stopReason: await new Promise((resolve, reject) => {
                        const inflight = {
                            resolve,
                            reject,
                            messageId: message.id,
                            turn: undefined,
                            endReason: undefined,
                        };
                        record.inflight = inflight;
                        try {
                            record.agent.followup(message);
                        }
                        catch (error) {
                            record.inflight = undefined;
                            throw internalError(`prompt was not queued: ${error instanceof Error ? error.message : String(error)}`);
                        }
                        record.agent.whenIdle().then(() => {
                            if (record.inflight !== inflight)
                                return;
                            record.inflight = undefined;
                            const end = inflight.endReason;
                            if (end === undefined)
                                inflight.resolve('cancelled');
                            else
                                inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end));
                        });
                    }),
                };
            },
            cancel(params) {
                const record = sessions.get(params.sessionId);
                if (record === undefined)
                    return Promise.resolve();
                record.commandAbort?.abort();
                failInFlightTools(record);
                record.agent.cancel({ kind: 'user' });
                settlePrompt(record, 'cancelled');
                return Promise.resolve();
            },
            setSessionMode(params) {
                assertOpen();
                const record = requireSession(params.sessionId);
                if (!isModeId(params.modeId))
                    throw invalidParams(`unknown mode: ${params.modeId}`);
                ctx.planMode.set(record.agent, params.modeId === MODE_PLAN);
                return Promise.resolve({});
            },
            async unstable_setSessionModel(params) {
                assertOpen();
                const record = requireSession(params.sessionId);
                let catalog = [];
                try {
                    catalog = await ctx.llm.listModels(catalogProvider);
                }
                catch (error) {
                    logger.warn(`acp: model catalog discovery failed: ${errorChain(error)}`);
                }
                if (!catalog.some((model) => model.id === params.modelId)) {
                    throw invalidParams(`unknown model: ${params.modelId} (available: ${catalog.map((model) => model.id).join(', ')})`);
                }
                const current = record.selection.current;
                const next = { provider: catalogProvider, model: params.modelId };
                if (current?.reasoningEffort !== undefined)
                    next.reasoningEffort = current.reasoningEffort;
                record.selection.current = next;
                return {};
            },
            async setSessionConfigOption(params) {
                assertOpen();
                const record = requireSession(params.sessionId);
                if (params.configId !== THOUGHT_LEVEL_CONFIG_ID) {
                    throw invalidParams(`unknown config option: ${params.configId}`);
                }
                const value = params.value;
                if (typeof value !== 'string' || !isEffortValue(value, record.efforts)) {
                    throw invalidParams(`invalid value for ${THOUGHT_LEVEL_CONFIG_ID}: ${String(value)}`);
                }
                const current = record.selection.current;
                if (current !== undefined) {
                    record.selection.current = { ...current, reasoningEffort: ReasoningEffortId(value) };
                }
                return { configOptions: [buildThoughtLevelOption(value, record.efforts)] };
            },
        };
    };
    conn = new AgentSideConnection(makeAgent, config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
    let quiescing;
    const quiesce = () => {
        if (quiescing !== undefined)
            return quiescing;
        closed = true;
        const records = [...sessions.values()];
        sessions.clear();
        for (const record of records) {
            for (const timer of record.broadcastTimers)
                clearTimeout(timer);
            record.broadcastTimers = [];
            record.commandAbort?.abort();
            failInFlightTools(record);
            record.agent.cancel({ kind: 'user' });
            settlePrompt(record, 'cancelled');
        }
        streamedSteps.clear();
        quiescing = (async () => {
            const subagents = ctx.get('subagents');
            if (subagents !== undefined) {
                try {
                    await subagents.drainContinuableDescendants(records.map((record) => record.agent));
                }
                catch (error) {
                    logger.warn(`acp: continuable subagent teardown failed: ${String(error)}`);
                }
            }
            for (const record of records)
                record.disposeSelection();
            const disposals = await Promise.allSettled(records.map((record) => record.dispose()));
            const failures = [];
            for (const result of disposals)
                if (result.status === 'rejected')
                    failures.push(result.reason);
            if (failures.length > 0) {
                const detail = failures.map((failure) => errorChain(failure)).join('; ');
                throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`);
            }
        })();
        return quiescing;
    };
    conn.closed
        .catch((error) => {
        logger.warn(`acp: connection closed with an error: ${String(error)}`);
    })
        .then(quiesce)
        .catch((error) => {
        logger.warn(`acp: connection-close teardown failed: ${String(error)}`);
    });
    ctx.effect(() => quiesce, 'dsh-acp-paseo.connection');
}
/** Pick the model id displayed as current in the catalog Paseo receives. */
function pickCurrentModelId(config, catalogProvider, catalog, defaultSelection) {
    if (config.model !== undefined)
        return config.model;
    if (defaultSelection.provider === catalogProvider &&
        catalog.some((model) => model.id === defaultSelection.model)) {
        return defaultSelection.model;
    }
    return catalog[0]?.id ?? defaultSelection.model;
}
/**
 * Build per-agent creation options. Config pins win; otherwise the deployment
 * default selection is used. Options are ALWAYS explicit: subagents inherit
 * `parent.options.provider/model` via `resolveChildAgentOptions`, and an
 * empty options object would leave the child's request route empty, failing
 * every child turn with "has no provider/model". (Web parity: the web host
 * passes the same explicit options on every session creation.)
 */
/**
 * Select the fork seed: a completed-turn prefix of the live parent log. dsh
 * rejects a seed that ends inside an open turn, so an in-flight turn is dropped.
 */
function forkSeedEvents(events) {
    const lastMarker = events.findLast((event) => event.type === 'turn/start' || event.type === 'turn/end');
    return lastMarker?.type === 'turn/start' ? events.slice(0, events.indexOf(lastMarker)) : events.slice();
}
function resolveAgentOptions(config, defaultSelection) {
    return {
        provider: config.provider ?? defaultSelection.provider,
        model: config.model ?? defaultSelection.model,
    };
}
/**
 * Convert one ACP prompt into dsh user content, preserving block order. Images
 * are admitted as a single batch before any member is published, and a prompt
 * without text is legal when it carries an image.
 */
async function toUserContent(attachments, prompt) {
    const images = prompt.filter((block) => block.type === 'image');
    const refs = images.length === 0
        ? []
        : await admitEncodedImages(attachments, images.map((block) => ({ mediaType: block.mimeType, data: block.data })));
    let next = 0;
    return prompt.flatMap((block) => {
        switch (block.type) {
            case 'text':
                return [{ type: 'text', text: block.text ?? '' }];
            case 'resource_link':
                return [{ type: 'text', text: acpPromptToText([block]) }];
            case 'image':
                return [{ type: 'image', attachment: refs[next++] }];
            default:
                return [];
        }
    });
}
/**
 * Flatten a persisted dsh user message into the text ACP replays. Images become
 * the same placeholder the live stream uses for assistant image blocks, because
 * a replayed turn cannot re-attach the original bytes.
 */
function userMessageText(data) {
    const blocks = data?.content ?? [];
    return blocks
        .flatMap((block) => {
        if (block.type === 'text')
            return block.text.length > 0 ? [block.text] : [];
        if (block.type === 'image')
            return [`[image attachment ${block.attachment?.attachmentId ?? 'unknown'}]`];
        return [];
    })
        .join('\n');
}
/** Reject session features outside the bridge contract. */
function validateSessionParams(params) {
    if (!isAbsolute(params.cwd))
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    // Newer protocol revisions carry additionalDirectories; reject it defensively.
    const additional = params.additionalDirectories;
    if (additional !== undefined && additional.length > 0) {
        throw invalidParams('additionalDirectories is not supported');
    }
    if (params.mcpServers.length > 0)
        throw invalidParams('mcpServers is not supported');
}
