#!/usr/bin/env node
/**
 * dsh-acp-paseo launcher — the stable entry Paseo spawns per agent.
 *
 * Responsibilities (all diagnostics on stderr; stdout stays protocol-pure):
 *   1. answer Paseo's `<command> --version` probe without booting dsh;
 *   2. locate a usable `dsh` binary (env override → PATH → snapshot);
 *   3. self-heal the dedicated `dsh-acp-paseo` profile (idempotent);
 *   4. pre-check the bundle is built;
 *   5. exec `dsh --profile dsh-acp-paseo`, forwarding signals and exit codes.
 *
 * Usage: dsh-acp-paseo-launch.mjs [--profile <name>] [extra dsh args...]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const IS_WIN = process.platform === 'win32'
const PREFIX = '[dsh-acp-paseo-launch]'

const require = createRequire(import.meta.url)
const pkg = require(join(PACKAGE_ROOT, 'package.json'))

/** Source checkout has a sibling `packages/` dir; published installs do not. */
const NPM_MODE = !existsSync(join(REPO_ROOT, 'packages'))

const DEFAULT_PROFILE = 'dsh-acp-paseo'

function log(message) {
  process.stderr.write(`${PREFIX} ${message}\n`)
}

function fail(message, hint) {
  log(`ERROR: ${message}`)
  if (hint) log(hint)
  process.exit(1)
}

function parseArgs(argv) {
  const args = [...argv]
  let profile = DEFAULT_PROFILE
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--profile') {
      const value = args[++i]
      if (value === undefined) fail('--profile requires a value')
      profile = value
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else {
      rest.push(arg)
    }
  }
  return { profile, rest }
}

/** Paseo's provider screen probes `<command> --version`; answer without booting dsh. */
function handleVersionProbe(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`dsh-acp-paseo-launch ${pkg.version}\n`)
    process.exit(0)
  }
}

/** Candidate executable names for the dsh binary on this platform. */
function dshBinaryNames() {
  if (!IS_WIN) return ['dsh']
  const names = ['dsh.cmd', 'dsh.bat', 'dsh.exe', 'dsh']
  return names
}

/** PATH lookup honoring PATHEXT on Windows. */
function findOnPath(binary) {
  const pathValue = process.env.PATH ?? ''
  const extensions = IS_WIN ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue
    for (const ext of extensions) {
      const candidate = join(dir, binary + ext.toLowerCase())
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        /* keep searching */
      }
    }
  }
  return undefined
}

function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.dsh')
}

/** Resolve the dsh binary: explicit env → PATH → snapshot install. */
function resolveDsh() {
  const explicit = process.env.DSH_ACP_PASEO_DSH
  if (explicit !== undefined && explicit.length > 0) {
    const resolved = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
    if (!existsSync(resolved)) {
      fail(`DSH_ACP_PASEO_DSH points at a missing file: ${resolved}`)
    }
    return resolved
  }
  for (const name of dshBinaryNames()) {
    const found = findOnPath(name)
    if (found !== undefined) return found
  }
  const snapshotBin = join(dshHome(), 'source', 'current', 'bin', IS_WIN ? 'dsh.cmd' : 'dsh')
  if (existsSync(snapshotBin)) return snapshotBin
  fail(
    'no dsh binary found',
    'Install DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness), or point DSH_ACP_PASEO_DSH at the binary.',
  )
}

/** The bundle spec `dsh plugin add` should install into the profile. */
function bundleSpec() {
  if (NPM_MODE) return `${pkg.name}@${pkg.version}`
  return PACKAGE_ROOT
}

/**
 * Self-heal: guarantee the profile exists and carries this bundle. Idempotent;
 * healthy profiles are left untouched. Creation/repair is delegated to
 * `dsh plugin add` — this script never hand-edits profile files.
 */
function ensureProfile(dsh, profile) {
  const manifestPath = join(dshHome(), 'profiles', profile, 'package.json')
  let healthy = false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    healthy = Array.isArray(bundles) && bundles.includes(pkg.name)
  } catch {
    healthy = false
  }
  if (healthy) return

  log(`profile '${profile}' missing the ${pkg.name} bundle — running dsh plugin add`)
  const result = spawnSync(dsh, ['plugin', '--profile', profile, 'add', bundleSpec()], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    fail(
      `dsh plugin add failed (exit ${result.status})`,
      `Run manually: dsh plugin --profile ${profile} add ${bundleSpec()} — check network/registry access.`,
    )
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(pkg.name)) {
      fail(`profile '${profile}' still lacks ${pkg.name} after dsh plugin add`)
    }
  } catch (error) {
    fail(`profile manifest unreadable after repair: ${String(error)}`)
  }
}

/** Fail early when the bundle has not been built (source checkout workflow). */
function preflightBuild() {
  const entry = join(PACKAGE_ROOT, 'lib', 'index.js')
  if (!existsSync(entry)) {
    fail(
      'bundle is not built (lib/index.js missing)',
      'Run `node scripts/build.mjs` in the dsh-acp-paseo repository first.',
    )
  }
}

function main() {
  handleVersionProbe(process.argv.slice(2))
  const { profile, rest } = parseArgs(process.argv.slice(2))
  const dsh = resolveDsh()
  preflightBuild()
  ensureProfile(dsh, profile)

  if (process.env.DSH_PERMISSION_MODE === undefined) {
    process.env.DSH_PERMISSION_MODE = 'workspace-write'
  }

  const args = ['--profile', profile, ...rest]
  const isCmd = IS_WIN && /\.cmd$|\.bat$/i.test(dsh)
  const child = spawn(dsh, args, {
    stdio: 'inherit',
    // Only .cmd/.bat shims need a shell on Windows; keep CVE-2024-27980 hardening otherwise.
    shell: isCmd,
    env: process.env,
  })

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal)
      } catch {
        /* child already gone */
      }
    })
  }

  child.on('error', (error) => {
    fail(`failed to start dsh: ${error.message}`)
  })

  child.on('exit', (code, signal) => {
    if (signal !== null) process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))
    process.exit(code ?? 0)
  })
}

main()
