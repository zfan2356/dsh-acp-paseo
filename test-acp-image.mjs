#!/usr/bin/env node
/**
 * End-to-end check for image prompts over the dsh ACP bridge: initialize
 * advertises `promptCapabilities.image`, a screenshot prompt reaches an
 * image-capable model (which answers about the picture), and the two rejection
 * contracts hold — images for a text-only model, and unsupported block types.
 *
 * The vision turn calls the real DeepSeek endpoint, so this test spends tokens.
 *
 * Usage: DSH_BIN=dsh node test-acp-image.mjs [cwd]
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { deflateSync } from 'node:zlib'

const CWD = process.argv[2] ?? '/root/wxg'
const DSH = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'dsh-acp-paseo'
const VISION_MODEL = process.env.DSH_IMAGE_MODEL ?? 'deepseek-flash'
const TEXT_MODEL = process.env.DSH_TEXT_MODEL ?? 'deepseek-v4-pro'

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A solid-color PNG is enough to prove the model received image pixels. */
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = r
      raw[off + 2 + x * 3] = g
      raw[off + 3 + x * 3] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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

  const request = (method, params, timeoutMs = 60_000) =>
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

const PNG_RED = solidPng(64, 64, [220, 30, 30])
const imageBlock = { type: 'image', data: PNG_RED.toString('base64'), mimeType: 'image/png' }

function agentText(notifications) {
  return notifications
    .map((msg) => msg.params?.update)
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('')
}

try {
  console.log('== initialize / session/new ==')
  const agent = startAgent()
  const init = await agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  assert(init.result?.agentCapabilities?.promptCapabilities?.image === true, 'initialize advertises promptCapabilities.image')

  const session = await agent.request('session/new', { cwd: CWD, mcpServers: [] })
  const sessionId = session.result?.sessionId
  assert(typeof sessionId === 'string' && sessionId.length > 0, `session/new -> ${sessionId}`)
  const models = (session.result?.models?.availableModels ?? []).map((model) => model.modelId)
  assert(models.includes(VISION_MODEL), `catalog offers ${VISION_MODEL} (${models.join(', ')})`)

  console.log('== text prompt on the default model ==')
  await agent.request('session/set_model', { sessionId, modelId: VISION_MODEL })
  const textTurn = await agent.request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: 'Reply with the single word: ok' }] },
    120_000,
  )
  assert(textTurn.result?.stopReason === 'end_turn', `text turn ended with ${textTurn.result?.stopReason}`)
  assert(/ok/i.test(agentText(agent.notifications)), 'text turn answered')

  console.log('== vision prompt on an image-capable model ==')
  await agent.request('session/set_model', { sessionId, modelId: VISION_MODEL })
  // The same image is offered up to three times: this model calls a solid
  // (220, 30, 30) square "green" or "neither" often enough that one turn is
  // not a verdict on whether the pixels arrived.
  let answer = ''
  for (let attempt = 1; attempt <= 3 && !/red/i.test(answer); attempt++) {
    const before = agent.notifications.length
    const vision = await agent.request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          { type: 'text', text: 'Answer with one word: is the dominant color of this image red or green?' },
          imageBlock,
        ],
      },
      180_000,
    )
    assert(vision.error === undefined, `image prompt accepted (no ${JSON.stringify(vision.error ?? null)})`)
    assert(vision.result?.stopReason === 'end_turn', `vision turn ended with ${vision.result?.stopReason}`)
    answer = agentText(agent.notifications.slice(before))
    console.log(`  attempt ${attempt}: ${JSON.stringify(answer.trim().slice(0, 60))}`)
  }
  assert(/red/i.test(answer), `model saw the image and answered red: ${JSON.stringify(answer.trim().slice(0, 80))}`)

  console.log('== image prompt on a text-only model ==')
  await agent.request('session/set_model', { sessionId, modelId: TEXT_MODEL })
  const refusal = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'what color?' }, imageBlock],
  })
  assert(refusal.error?.code === -32602, `text-only model refuses images with invalid params (${refusal.error?.code})`)
  assert(
    /does not accept image input/.test(refusal.error?.message ?? ''),
    `refusal names the capability: ${JSON.stringify(refusal.error?.message)}`,
  )

  console.log('== unsupported prompt content is still rejected ==')
  const audio = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }],
  })
  assert(audio.error?.code === -32602, `audio block rejected with invalid params (${audio.error?.code})`)

  const empty = await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '   ' }] })
  assert(empty.error?.code === -32602, `blank text prompt rejected with invalid params (${empty.error?.code})`)

  await agent.stop()
  console.log('\nALL CHECKS PASSED')
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
}
