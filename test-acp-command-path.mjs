#!/usr/bin/env node
/**
 * End-to-end check for prompt routing over the dsh ACP bridge: a message that
 * starts with an absolute path reaches the model instead of failing the prompt
 * with `-32602 unknown command`, while a registered command still runs as one.
 *
 * The regression it pins: Paseo sent `/srv/data/...` plus prose, the bridge
 * parsed it as a slash command, and the whole message was lost to
 * `Invalid params: unknown command: //srv/data/...`.
 *
 * The path prompts call the real model, so this test spends a few tokens.
 *
 * Usage: DSH_BIN=dsh node test-acp-command-path.mjs [cwd]
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const CWD = process.argv[2] ?? '/root/wxg'
const DSH = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'dsh-acp-paseo'

function startAgent() {
  const child = spawn(DSH, ['--profile', PROFILE], {
    cwd: CWD,
    env: process.env,
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
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })}\n`,
      )
      return
    }
    notifications.push(msg)
  })

  const request = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out; stderr tail:\n${stderr.join('').slice(-2000)}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg.error ? { error: msg.error } : { result: msg.result })
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const stop = () =>
    new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 10_000).unref()
    })

  return { request, stop, notifications, stderr }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`  ok: ${message}`)
}

const availableCommands = (notifications) =>
  notifications
    .map((msg) => msg.params?.update)
    .filter((update) => update?.sessionUpdate === 'available_commands_update')
    .flatMap((update) => update.availableCommands ?? [])
    .map((command) => command.name)

function agentText(notifications) {
  return notifications
    .map((msg) => msg.params?.update)
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The exact message shape Paseo sent when the bug fired. */
const REPORTED_MESSAGE = [
  '/srv/data/pretrain/configs/example/mm_train_continual_pretrain.yaml',
  '',
  'Ignore the path above. Reply with the single word: ok',
].join('\n')

try {
  console.log('== initialize / session/new ==')
  const agent = startAgent()
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await agent.request('session/new', { cwd: CWD, mcpServers: [] })
  const sessionId = session.result?.sessionId
  assert(typeof sessionId === 'string' && sessionId.length > 0, `session/new -> ${sessionId}`)
  await sleep(1500)
  const commands = availableCommands(agent.notifications)
  assert(commands.includes('feedback'), `bridge advertises the /feedback command (${commands.join(', ')})`)

  console.log('== a message starting with a path reaches the model ==')
  const pathTurn = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: REPORTED_MESSAGE }],
  })
  assert(pathTurn.error === undefined, `path prompt accepted (no ${JSON.stringify(pathTurn.error ?? null)})`)
  assert(pathTurn.result?.stopReason === 'end_turn', `path prompt ended with ${pathTurn.result?.stopReason}`)
  assert(/ok/i.test(agentText(agent.notifications)), 'model answered the path-leading message')

  console.log('== a command-shaped absolute path is a message, not an unknown command ==')
  const bare = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/tmp 这个目录是存在的，回复收到两个字即可' }],
  })
  assert(bare.error === undefined, `unregistered /tmp prompt accepted (no ${JSON.stringify(bare.error ?? null)})`)
  assert(bare.result?.stopReason === 'end_turn', `unregistered /tmp prompt ended with ${bare.result?.stopReason}`)

  console.log('== a registered command still executes as a command ==')
  const before = agent.notifications.length
  const command = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/feedback acp passthrough smoke' }],
  })
  assert(command.error === undefined, `command accepted (no ${JSON.stringify(command.error ?? null)})`)
  assert(
    /Feedback recorded/.test(agentText(agent.notifications.slice(before))),
    'command result came back as agent text',
  )

  await agent.stop()
  console.log('\nALL CHECKS PASSED')
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
}
