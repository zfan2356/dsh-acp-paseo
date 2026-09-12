#!/usr/bin/env node
/**
 * Register dsh as a Paseo custom ACP provider.
 *
 * Merges the provider entry into `$PASEO_HOME/config.json` under
 * `agents.providers.dsh` (idempotent, backs the file up first). The entry
 * declares NO `models` and NO `env` — Paseo discovers the model catalog,
 * modes, thinking levels and commands from dsh over ACP at runtime, and dsh
 * resolves its own `DEEPSEEK_API_KEY` credential.
 *
 * Usage:
 *   dsh-acp-paseo-install-provider [--paseo-home <dir>] [--launcher <path>] [--dry-run]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const IS_WIN = process.platform === 'win32'
const PROVIDER_ID = 'dsh'

function parseArgs(argv) {
  const options = { paseoHome: undefined, launcher: undefined, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--paseo-home':
        options.paseoHome = argv[++i]
        break
      case '--launcher':
        options.launcher = argv[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        process.stderr.write(`unknown argument: ${arg}\n`)
        process.exit(2)
    }
  }
  return options
}

function printHelp() {
  process.stdout.write(
    [
      'Register dsh as a Paseo ACP provider.',
      '',
      'Options:',
      '  --paseo-home <dir>   Paseo home (default: $PASEO_HOME or ~/.paseo)',
      '  --launcher <path>    Launcher script path (default: this package\'s bin)',
      '  --dry-run            Print the merged config without writing',
      '  -h, --help           Show this help',
      '',
    ].join('\n'),
  )
}

function homeDir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? '~'
}

function resolvePaseoHome(flag) {
  if (flag !== undefined) return isAbsolute(flag) ? flag : resolve(process.cwd(), flag)
  const env = process.env.PASEO_HOME
  if (env !== undefined && env.length > 0) return isAbsolute(env) ? env : resolve(process.cwd(), env)
  return join(homeDir(), '.paseo')
}

function resolveLauncher(flag) {
  const launcher = flag !== undefined ? flag : join(PACKAGE_ROOT, 'bin', 'dsh-acp-paseo-launch.mjs')
  const absolute = isAbsolute(launcher) ? launcher : resolve(process.cwd(), launcher)
  if (!existsSync(absolute)) {
    process.stderr.write(`launcher not found: ${absolute}\n`)
    process.exit(1)
  }
  return absolute
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const paseoHome = resolvePaseoHome(options.paseoHome)
  const launcher = resolveLauncher(options.launcher)
  const configPath = join(paseoHome, 'config.json')

  const templatePath = join(PACKAGE_ROOT, 'paseo', 'provider.dsh.json')
  const entry = JSON.parse(readFileSync(templatePath, 'utf8'))
  entry.command = IS_WIN ? [process.execPath, launcher] : [launcher]

  let config = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (error) {
      process.stderr.write(`cannot parse ${configPath}: ${String(error)}\n`)
      process.exit(1)
    }
  }

  config.agents ??= {}
  config.agents.providers ??= {}
  const previous = config.agents.providers[PROVIDER_ID]
  config.agents.providers[PROVIDER_ID] = entry

  const rendered = `${JSON.stringify(config, null, 2)}\n`

  if (options.dryRun) {
    process.stdout.write(`[dry-run] would write ${configPath}\n`)
    process.stdout.write(`[dry-run] provider entry:\n${JSON.stringify(entry, null, 2)}\n`)
    return
  }

  mkdirSync(paseoHome, { recursive: true })
  if (existsSync(configPath)) {
    const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(configPath, backup)
    process.stdout.write(`backed up existing config to ${backup}\n`)
  }
  writeFileSync(configPath, rendered, 'utf8')
  process.stdout.write(
    [
      `registered provider '${PROVIDER_ID}' in ${configPath}`,
      previous !== undefined ? '(replaced an existing dsh entry — e.g. from renat3u/dsh-paseo)' : '',
      '',
      'Next steps:',
      '  1. make sure dsh itself is configured (DEEPSEEK_API_KEY via env, $DSH_HOME/.credentials.yaml or .env)',
      '  2. restart the Paseo daemon (`paseo restart` or relaunch the app)',
      "  3. create an agent with provider 'dsh' — models/modes/commands are discovered automatically",
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )
}

main()
