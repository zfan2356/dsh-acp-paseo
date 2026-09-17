#!/usr/bin/env node
/**
 * Fast ACP handshake check: boots the patched bridge and asserts `initialize`
 * advertises session fork/resume plus image prompts.
 *
 * Usage: DSH_BIN=<path-to-dsh-bin.js> [DSH_HOME=...] node acp-handshake-check.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const DSH = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'dsh-acp-paseo'
const CWD = process.env.CHECK_CWD ?? '/root/wxg'

const child = spawn(DSH, ['--profile', PROFILE], {
  cwd: CWD,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const stderrChunks = []
child.stderr.on('data', (d) => stderrChunks.push(d.toString()))

const rl = createInterface({ input: child.stdout })
const timer = setTimeout(() => finish(1, 'timeout waiting for initialize reply'), 60000)

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== 1) return
  if (msg.error) return finish(1, `initialize error: ${JSON.stringify(msg.error)}`)
  const caps = msg.result?.agentCapabilities ?? {}
  const fork = caps.sessionCapabilities?.fork !== undefined
  const resume = caps.sessionCapabilities?.resume !== undefined
  const image = caps.promptCapabilities?.image === true
  const ok = fork && resume && image
  finish(ok ? 0 : 1, `fork=${fork} resume=${resume} image=${image}`)
})

function finish(code, detail) {
  clearTimeout(timer)
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${PROFILE}: ${detail}`)
  if (code !== 0 && stderrChunks.length) {
    console.log('--- bridge stderr tail ---')
    console.log(stderrChunks.join('').split('\n').slice(-12).join('\n'))
  }
  try {
    child.kill('SIGTERM')
  } catch {}
  process.exit(code)
}

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  })}\n`,
)
