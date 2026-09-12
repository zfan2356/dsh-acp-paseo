#!/usr/bin/env node
/**
 * End-to-end check for the patched dsh ACP bridge: initialize advertises
 * `session/fork` + `session/resume`, `session/fork` returns a new session id,
 * and a second process can resume that forked session.
 *
 * Usage: node test-acp-fork.mjs [cwd]
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
      // Header/selection requests are irrelevant to this transport check.
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })}\n`)
      return
    }
    notifications.push(msg)
  })

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve })
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out; stderr tail:\n${stderr.join('').slice(-2000)}`))
      }, 60_000)
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.error) reject(new Error(`${method} -> ${JSON.stringify(msg.error)}\nstderr tail:\n${stderr.join('').slice(-2000)}`))
          else resolve(msg.result)
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

  return { request, stop, stderr }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`  ok: ${message}`)
}

const failures = []
try {
  console.log('== process A: initialize / session/new / session/fork ==')
  const a = startAgent()
  const init = await a.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  const caps = init.agentCapabilities?.sessionCapabilities
  assert(caps?.fork !== undefined, 'initialize advertises sessionCapabilities.fork')
  assert(caps?.resume !== undefined, 'initialize advertises sessionCapabilities.resume')

  const parent = await a.request('session/new', { cwd: CWD, mcpServers: [] })
  assert(typeof parent.sessionId === 'string' && parent.sessionId.length > 0, `session/new -> ${parent.sessionId}`)

  const forked = await a.request('session/fork', { sessionId: parent.sessionId, cwd: CWD, mcpServers: [] })
  assert(typeof forked.sessionId === 'string' && forked.sessionId.length > 0, `unstable_forkSession -> ${forked.sessionId}`)
  assert(forked.sessionId !== parent.sessionId, 'fork produced an independent session id')

  const nested = await a.request('session/fork', { sessionId: forked.sessionId, cwd: CWD, mcpServers: [] })
  assert(nested.sessionId !== forked.sessionId && nested.sessionId !== parent.sessionId, `fork of a fork -> ${nested.sessionId}`)

  const forkedSessionId = forked.sessionId
  await a.stop()
  console.log('  (process A exited; session flushed to the jsonl store)')

  console.log('== process B: unstable_resumeSession on the forked session ==')
  const b = startAgent()
  const initB = await b.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  assert(initB.agentCapabilities?.sessionCapabilities?.resume !== undefined, 'process B advertises session/resume')
  const resumed = await b.request('session/resume', { sessionId: forkedSessionId, cwd: CWD, mcpServers: [] })
  assert(resumed.sessionId === forkedSessionId, `resume attached to the same session (${resumed.sessionId})`)
  await b.stop()
  console.log('\nALL CHECKS PASSED')
} catch (error) {
  failures.push(error)
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
}
