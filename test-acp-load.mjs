#!/usr/bin/env node
/**
 * End-to-end check for the patched dsh ACP bridge: `initialize` advertises
 * `loadSession`, and `session/load` replays a persisted conversation as ACP
 * updates — user turns, assistant text/reasoning, tool calls — before it
 * answers, so a client that keeps no timeline of its own (Paseo after a daemon
 * restart) opens the session with its history instead of an empty chat.
 *
 * The fixture is a hand-written session log in an isolated `$DSH_HOME`, so the
 * check needs no model call and never touches a real conversation.
 *
 * Usage: node test-acp-load.mjs [cwd]
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const CWD = process.argv[2] ?? '/root/wxg'
const DSH = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'dsh-acp-paseo'
const runningAgents = new Set()
const REAL_HOME = process.env.DSH_REAL_HOME ?? '/root/.dsh'
/** Isolated home for the fixture. Deliberately not `DSH_HOME`: dsh exports that
 *  as the real home, and this check must never write into it. */
const DSH_HOME = process.env.DSH_TEST_HOME ?? '/root/wxg/.dsh-acp-test'

/** A persisted session id is opaque to the bridge; this one is fixed so the
 *  fixture path is stable and a stale run cannot be mistaken for a fresh one. */
const SESSION_ID = '7f2a1c40-5b0e-4a3d-9c81-6e0d2b4f7a10'
const USER_MESSAGE_ID = '2b8c7d91-4a3e-4c5f-8b1d-9e0a6c3f2d47'
const ASSISTANT_MESSAGE_ID = 'c41d9e77-6b2a-4f80-9d3c-5a7e1b8f2c60'
const ANSWER_MESSAGE_ID = 'a1f7c2d8-3e94-4b16-8c05-7d2f9a4e6b31'
const QUESTION = 'Replay fixture: what does the bridge send on session/load?'
const REASONING = 'Replay fixture reasoning.'
const ANSWER = 'Replay fixture answer.'
const TOOL_RESULT_MESSAGE_ID = '5d0b3a86-9c47-4e21-a6f8-2b7c1e904d35'
const CALL_ID = 'call_fixture_1'
const CALL_COMMAND = '{"command":"echo fixture"}'
const CALL_OUTPUT = 'fixture'

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(`ASSERT FAILED: ${message}`)
  console.log(`  ok: ${message}`)
}

/** dsh buckets sessions per cwd: `/root/wxg` -> `--root-wxg--`. */
function sessionBucket(cwd) {
  return `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`
}

function zstdCompress(buffer) {
  if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(buffer)
  const proc = spawnSync('zstd', ['-q', '-c'], { input: buffer, maxBuffer: 64 * 1024 * 1024 })
  if (proc.status !== 0) fail(`zstd compression failed: ${proc.stderr}`)
  return proc.stdout
}

function readStoredSession(sessionId) {
  const folder = join(DSH_HOME, 'sessions', sessionBucket(CWD), sessionId)
  const migrated = join(folder, 'session.v3.jsonl.zstd')
  const path = existsSync(migrated) ? migrated : join(folder, 'session.jsonl.zstd')
  const compressed = readFileSync(path)
  const proc = spawnSync('zstd', ['-q', '-d', '-c'], { input: compressed })
  if (proc.status !== 0) fail(`zstd decompression failed: ${proc.stderr}`)
  return proc.stdout.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
}

/**
 * Boot an isolated dsh home holding just this profile, so the fixture log is
 * never written into the real home (dsh rewrites cordis.yml at boot).
 */
function ensureHome() {
  if (!existsSync(join(DSH_HOME, 'profiles', PROFILE))) {
    mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })
    cpSync(join(REAL_HOME, 'profiles', PROFILE), join(DSH_HOME, 'profiles', PROFILE), {
      recursive: true,
    })
    for (const file of ['.credentials.yaml', '.env', 'settings.yaml', '.anonymous-user-id']) {
      const source = join(REAL_HOME, file)
      if (existsSync(source)) cpSync(source, join(DSH_HOME, file))
    }
  }
  // The repo's lib is the source of truth: overlay it on the profile's copy so
  // this check exercises the working tree, not whatever was last installed.
  const installed = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-acp-paseo')
  if (!existsSync(installed)) fail(`no installed bridge at ${installed}`)
  cpSync(join(REPO_ROOT, 'lib'), join(installed, 'lib'), { recursive: true })
  // A resume may append to the log; start every run from the fixture.
  const fixtureDir = join(DSH_HOME, 'sessions', sessionBucket(CWD), SESSION_ID)
  rmSync(fixtureDir, { recursive: true, force: true })
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(join(fixtureDir, 'session.jsonl.zstd'), fixtureLog())
  return fixtureDir
}

/**
 * One completed turn: a user prompt, a tool step, then the final answer.
 *
 * The log is stored as independently decodable zstd frames, and dsh requires
 * the first frame to hold exactly the header line, so the header gets its own
 * frame and the events follow in a second one.
 */
function fixtureLog() {
  const [header, ...events] = fixtureEvents()
  const frame = (lines) => zstdCompress(Buffer.from(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8'))
  return Buffer.concat([frame([header]), frame(events)])
}

function fixtureEvents() {
  const base = 1789354633000
  return [
    { type: 'session', version: 0, id: SESSION_ID, createdAt: base, cwd: CWD, delegationDepth: 0 },
    { type: 'permission/preset', seq: 0, time: base + 1, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: base + 2, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, time: base + 3, data: { policy: 'ask' } },
    {
      type: 'agent/inbox/spliced',
      seq: 3,
      time: base + 4,
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [
          {
            content: [{ type: 'text', text: QUESTION }],
            source: { kind: 'user' },
            role: 'user',
            id: USER_MESSAGE_ID,
          },
        ],
      },
    },
    { type: 'turn/start', seq: 4, time: base + 5, data: { turn: 1 } },
    { type: 'step/start', seq: 5, time: base + 6, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 6,
      time: base + 7,
      data: {
        content: [{ type: 'text', text: QUESTION }],
        source: { kind: 'user' },
        role: 'user',
        id: USER_MESSAGE_ID,
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 7,
      time: base + 8,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: REASONING },
            { type: 'tool-call', id: CALL_ID, name: 'bash', arguments: CALL_COMMAND },
          ],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          id: ASSISTANT_MESSAGE_ID,
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 8,
      time: base + 9,
      data: { turn: 1, step: 1, callId: CALL_ID, name: 'bash', arguments: CALL_COMMAND },
    },
    {
      type: 'tool/result',
      seq: 9,
      time: base + 10,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: CALL_ID },
          role: 'user',
          id: TOOL_RESULT_MESSAGE_ID,
          content: [
            {
              type: 'tool-result',
              toolCallId: CALL_ID,
              content: [{ type: 'text', text: CALL_OUTPUT }],
              isError: false,
            },
          ],
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 10, time: base + 11, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 11, time: base + 12, data: { turn: 1, step: 2 } },
    {
      type: 'assistant/message',
      seq: 12,
      time: base + 13,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: ANSWER }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          id: ANSWER_MESSAGE_ID,
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 13, time: base + 14, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 14, time: base + 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function startAgent() {
  const child = spawn(DSH, ['--profile', PROFILE], {
    cwd: CWD,
    env: { ...process.env, DSH_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  child.stderr.on('data', (d) => stderr.push(d.toString()))

  const pending = new Map()
  const notifications = []
  let nextId = 1
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (line.trim().length === 0) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
      return
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // Header/selection requests are irrelevant to this transport check.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })}\n`,
      )
      return
    }
    if (msg.method === 'session/update') notifications.push(msg.params)
  })

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out; stderr tail:\n${stderr.join('').slice(-2000)}`))
      }, 60_000)
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.error) {
            reject(
              new Error(
                `${method} -> ${JSON.stringify(msg.error)}\nstderr tail:\n${stderr.join('').slice(-2000)}`,
              ),
            )
          } else resolve(msg.result)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 10_000).unref()
    })

  const agent = { request, stop, notifications, stderr }
  runningAgents.add(agent)
  return agent
}

/** Text of an ACP content chunk, ignoring unrelated update kinds. */
function chunkText(update) {
  return update?.content?.type === 'text' ? update.content.text : undefined
}

const fixtureDir = ensureHome()
console.log(`fixture: ${join(fixtureDir, 'session.jsonl.zstd')}`)
console.log(`DSH_HOME: ${DSH_HOME}`)

try {
  console.log('== initialize / session/load ==')
  const agent = startAgent()
  const init = await agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  assert(init.agentCapabilities?.loadSession === true, 'initialize advertises loadSession')
  assert(
    init.agentCapabilities?.sessionCapabilities?.resume !== undefined,
    'initialize keeps sessionCapabilities.resume',
  )

  const loaded = await agent.request('session/load', {
    sessionId: SESSION_ID,
    cwd: CWD,
    mcpServers: [],
  })
  assert(loaded.sessionId === SESSION_ID, `session/load attached to ${loaded.sessionId}`)
  const availableModels = loaded.models?.availableModels ?? []
  assert(
    availableModels.length > 0,
    `session/load returns the model catalog (${availableModels.length} models)`,
  )
  assert(Array.isArray(loaded.configOptions), 'session/load returns config options')

  // Give the command-broadcast ladder time to land before draining.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const forked = await agent.request('session/fork', { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] })
  assert(forked.sessionId !== SESSION_ID, 'fork of restored history has a separate identity')
  await agent.stop()

  const [forkHeader, ...forkEvents] = readStoredSession(forked.sessionId)
  assert(forkHeader.parentSession === SESSION_ID, 'fork keeps its parent lineage')
  assert(forkHeader.isSeeded === true, 'fork header marks its inherited history')
  assert(!Object.hasOwn(forkHeader, 'seedLength'), 'fork does not write retired seedLength metadata')
  assert(
    forkEvents.some((event) => event.type === 'session/end-seed' && event.data.inherited === true && event.seq > 0),
    'fork persists the inherited event boundary',
  )

  const replayed = agent.notifications
    .map((params) => params.update)
    .filter((update) => update !== undefined)
  const userChunks = replayed.filter((u) => u.sessionUpdate === 'user_message_chunk')
  const textChunks = replayed.filter((u) => u.sessionUpdate === 'agent_message_chunk')
  const thoughtChunks = replayed.filter((u) => u.sessionUpdate === 'agent_thought_chunk')
  const toolCalls = replayed.filter((u) => u.sessionUpdate === 'tool_call')
  const toolResults = replayed.filter((u) => u.sessionUpdate === 'tool_call_update')

  assert(userChunks.length === 1, `replayed exactly one user turn (${userChunks.length})`)
  assert(chunkText(userChunks[0]) === QUESTION, 'user turn carries the persisted prompt')
  assert(userChunks[0]?.messageId === USER_MESSAGE_ID, 'user turn keeps the persisted message id')
  assert(thoughtChunks.length === 1, `replayed one reasoning chunk (${thoughtChunks.length})`)
  assert(chunkText(thoughtChunks[0]) === REASONING, 'reasoning text matches the log')
  assert(textChunks.length === 1, `replayed one assistant text chunk (${textChunks.length})`)
  assert(chunkText(textChunks[0]) === ANSWER, 'assistant answer matches the log')
  assert(
    textChunks[0]?.messageId === ANSWER_MESSAGE_ID,
    'assistant text carries the dsh message id',
  )
  assert(toolCalls.length === 1, `replayed one tool call (${toolCalls.length})`)
  assert(
    toolCalls[0]?.toolCallId === CALL_ID && toolCalls[0]?.status === 'in_progress',
    'tool call is in progress',
  )
  assert(toolResults.length === 1, `replayed one tool result (${toolResults.length})`)
  assert(
    toolResults[0]?.toolCallId === CALL_ID && toolResults[0]?.status === 'completed',
    'tool result closes the call',
  )

  // The conversation must arrive before the response, not after it: Paseo only
  // collects updates while its load request is in flight.
  const order = agent.notifications
    .map((params) => params.update?.sessionUpdate)
    .filter((kind) => kind === 'user_message_chunk' || kind === 'agent_message_chunk')
  assert(
    order.join(',') === 'user_message_chunk,agent_message_chunk',
    `replay order is user then assistant (${order.join(',')})`,
  )

  // A second process must be able to replay the same session: that is the
  // daemon-restart case this patch exists for.
  console.log('== second process replays the same session ==')
  const again = startAgent()
  await again.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  await again.request('session/load', { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const secondText = again.notifications
    .map((params) => params.update)
    .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
    .map(chunkText)
  assert(secondText.includes(ANSWER), 'a fresh process replays the same conversation')

  again.notifications.length = 0
  await again.request('session/load', { sessionId: forked.sessionId, cwd: CWD, mcpServers: [] })
  assert(
    again.notifications.some(({ update }) => update?.sessionUpdate === 'agent_message_chunk' && chunkText(update) === ANSWER),
    'a fresh process replays the fork with its inherited answer',
  )
  await again.stop()

  console.log('\nALL CHECKS PASSED')
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  await Promise.all([...runningAgents].map((agent) => agent.stop()))
}
