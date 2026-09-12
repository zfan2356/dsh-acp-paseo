#!/usr/bin/env node
/**
 * Unit check for the ACP prompt/codec translation: slash-command detection,
 * text flattening, and content admission. No dsh process, no tokens.
 *
 * The regression it pins: a Paseo message that starts with an absolute path
 * (`/srv/data/...`) was treated as a slash command, so the bridge answered
 * `-32602 Invalid params: unknown command: //srv/data/...` and the message
 * never reached the model.
 *
 * Usage: node test-codec.mjs
 */
import {
  acpPromptToText,
  extractSlashCommand,
  promptHasUnsupportedContent,
  slashCommandName,
  turnEndToStopReason,
} from './lib/codec.js'

let failed = 0

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}

const text = (value) => [{ type: 'text', text: value }]
/** Every name registered, so only the grammar decides. */
const anyCommand = () => true
/** No name registered: a path-shaped prompt must still not be a command. */
const noCommand = () => false

console.log('== slashCommandName grammar ==')
check('/help -> help', slashCommandName('/help'), 'help')
check('/goal set x -> goal', slashCommandName('/goal set x'), 'goal')
check('/compact-v2 -> compact-v2', slashCommandName('/compact-v2'), 'compact-v2')
check('tab-separated name', slashCommandName('/goal\tset'), 'goal')
check('/srv/data/x is not a command', slashCommandName('/srv/data/x'), undefined)
check('/tmp/ is not a command', slashCommandName('/tmp/'), undefined)
check('/1abc is not a command', slashCommandName('/1abc'), undefined)
check('/ is not a command', slashCommandName('/'), undefined)

console.log('== extractSlashCommand shapes ==')
check('single command line', extractSlashCommand(text('  /help  '), anyCommand), '/help')
check('command with args', extractSlashCommand(text('/goal set objective'), anyCommand), '/goal set objective')
check('multi block is never a command', extractSlashCommand([{ type: 'text', text: '/help' }, { type: 'resource_link', uri: 'file:///x' }], anyCommand), undefined)
check('non-text block is never a command', extractSlashCommand([{ type: 'resource_link', uri: 'file:///x' }], anyCommand), undefined)
check('mid-text slash is prose', extractSlashCommand(text('see /mnt/x for details'), anyCommand), undefined)

console.log('== the reported bug: a leading absolute path is a message ==')
const reported = [
  '/srv/data/pretrain/configs/example/mm_train_continual_pretrain.yaml',
  '',
  'One last check: is the balance-info cache for this yaml already built?',
  '',
  'I will start the job with the image built from https://code.example.com/org/repo/-/merge_requests/2971',
].join('\n')
check('multi-line message starting with a path', extractSlashCommand(text(reported), anyCommand), undefined)
check('bare absolute path', extractSlashCommand(text('/srv/data/x'), anyCommand), undefined)
check('bare /tmp (command-shaped, unregistered)', extractSlashCommand(text('/tmp'), noCommand), undefined)
check('bare /nope (command-shaped, unregistered)', extractSlashCommand(text('/nope'), noCommand), undefined)
check('registered name still passes through', extractSlashCommand(text('/goal status'), anyCommand), '/goal status')
check('registered /tmp-like name passes through', extractSlashCommand(text('/tmp'), anyCommand), '/tmp')

console.log('== unchanged codec contracts ==')
check('text flattens verbatim', acpPromptToText(text('a\nb')), 'a\nb')
check('resource_link becomes a bracketed reference', acpPromptToText([{ type: 'resource_link', name: 'f', uri: 'file:///f' }]), '\n[resource_link name="f" uri="file:///f"]\n')
check('image block carries no text', acpPromptToText([{ type: 'image', data: 'AA', mimeType: 'image/png' }]), '')
check('image is supported content', promptHasUnsupportedContent([{ type: 'image' }]), false)
check('audio is unsupported content', promptHasUnsupportedContent([{ type: 'audio' }]), true)
check('completed -> end_turn', turnEndToStopReason({ kind: 'completed' }), 'end_turn')
check('interrupted -> cancelled', turnEndToStopReason({ kind: 'interrupted' }), 'cancelled')

if (failed > 0) {
  console.error(`\nFAILED: ${failed} check(s)`)
  process.exitCode = 1
} else {
  console.log('\nALL CHECKS PASSED')
}
