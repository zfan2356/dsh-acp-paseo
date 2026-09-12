# dsh-acp-paseo (fork)

Fork of the published npm package [`dsh-acp-paseo@0.1.0`](https://www.npmjs.com/package/dsh-acp-paseo),
patched so Paseo can open a **Side Chat** on a dsh (DeepSeek Harness) agent,
send **screenshot (image) prompts** to an image-capable dsh model, and keep
**messages that start with a path** (and native slash commands) working.

Repository: <https://github.com/zfan2356/dsh-acp-paseo>

## Why this fork exists

The published package is MIT and maintained by `phoebe-southwood <hannu666@163.com>`,
but its `package.json` declares **no `repository`**, so there is no upstream source
tree to fork or send a pull request to. Only the built bundle ships. This repository
therefore vendors the published files and carries the delta as a patch.

## Patch: ACP session fork + resume

`patches/0001-acp-session-fork-and-resume.patch` changes `lib/index.js` only:

1. `initialize` advertises `sessionCapabilities: { fork: {}, resume: {} }`.
2. `session/fork` (SDK `unstable_forkSession`) forks the live dsh session into an
   independent one. The seed is the parent's event log truncated to its last
   completed turn, because dsh rejects a seed that ends inside an open turn.
3. `session/resume` (SDK `unstable_resumeSession`) attaches a fresh bridge process
   to a persisted session through `ctx.agents.resume`. The resumed side-chat agent
   runs in its own process, so this is what makes the fork reusable.
4. The per-session publication tail of `session/new` moved into a shared
   `publishSession`, used by all three entry points.

Paseo resolves these hooks from the advertised capability bit
(`packages/server/src/server/agent/providers/acp-agent.ts` in the Paseo fork), so
no per-provider flag is needed on the daemon side.

## Patch: image (screenshot) prompts

`patches/0002-acp-image-prompt-support.patch` changes `lib/index.js`,
`lib/codec.js`, and `package.json`:

1. `initialize` advertises `promptCapabilities.image: true`. The stock bridge
   advertised `image: false` and answered every screenshot with
   `-32602 only text and resource_link prompt content is supported`.
2. `session/prompt` admits ACP `image` blocks into the dsh attachment store
   (`admitEncodedImages`, the same durable path the dsh web host uses) and builds
   ordered dsh user content: text and `resource_link` blocks flatten as before,
   images become `{ type: 'image', attachment }` blocks. A prompt with an image
   needs no text partner, so a bare screenshot is a legal message.
3. An image prompt for a text-only model is refused before anything is stored,
   with `-32602 model "<id>" does not accept image input` (parity with the web
   host's `MODEL_DOES_NOT_SUPPORT_IMAGES`), and image-admission failures surface
   as invalid-params rather than internal errors.
4. `codec.js` keeps rejecting content outside text / `resource_link` / `image`
   (audio, embedded context) instead of dropping it silently.

dsh itself already supported image input end to end: `dsh-attachment` stores the
bytes, and `llm-deepseek` serializes them for models whose catalog entry lists
`inputModalities: [text, image]` (`deepseek-flash` = V4.1 Flash does; the text-only
`deepseek-v4-pro` rejects images with `UNSUPPORTED_CONTENT`). Only the ACP bridge
was dropping them.

## Patch: prompt routing — paths vs. slash commands

`patches/0003-acp-prompt-routing.patch` changes `lib/index.js`, `lib/codec.js`,
and `lib/types/codec.d.ts`, fixing two defects that made real Paseo messages fail:

1. `extractSlashCommand` treated **any** prompt whose trimmed text starts with
   `/` as a slash command. A message beginning with an absolute path was
   therefore rejected before it reached the model:

   ```
   /srv/data/pretrain/configs/example/mm_train_continual_pretrain.yaml
   ...
   ```

   answered `-32602 Invalid params: unknown command: //srv/data/...`, and the
   user's text was lost. Detection now mirrors the registry's grammar
   (`/^[a-z][a-z0-9_-]*(\s|$)/`) **and** requires the name to be registered for
   that session, so `/srv/data/x`, `/tmp`, `/1abc`, and prose containing a
   slash stay ordinary messages. An unknown name over ACP is a message too:
   there is no composer menu to correct it, and failing the prompt loses the
   text.
2. `runSlashCommand` called `ctx.commands.execute(agent, line, abort.signal)`,
   but the rc.8 registry order is `(agent, line, images, signal)`. The signal
   landed in `images`, `invocation.signal` stayed `undefined`, and **every**
   registered native command (`/goal`, `/compact`, `/permission`, `/plan`,
   `/feedback`) died with
   `-32603 Internal error: command failed: Cannot read properties of undefined (reading 'aborted')`.

## Layout

- `lib/`, `bin/`, `scripts/`, `paseo/`, `cordis.patch.yml`, `package.json` —
  the published package, with the patches applied.
- `patches/` — the delta against `dsh-acp-paseo@0.1.0`, applied in numeric order.
- `test-codec.mjs` — pure unit checks for prompt/codec translation, including the
  path-leading-message regression. No dsh process, no tokens.
- `test-acp-command-path.mjs` — dependency-free ACP client that boots
  `dsh --profile dsh-acp-paseo` and proves a path-leading message reaches the
  model, a command-shaped path (`/tmp`) is a message, and a registered command
  still executes as a command. Spends a few tokens.
- `test-acp-fork.mjs` — dependency-free ACP client that boots
  `dsh --profile dsh-acp-paseo`, checks the advertised capabilities, forks twice,
  and resumes the forked session from a second process.
- `test-acp-image.mjs` — same client, checks the image capability bit, sends a
  generated PNG to an image-capable model and requires a vision answer, then
  asserts the text-only-model, audio-block, and blank-prompt rejections.

## Verify

```bash
node test-codec.mjs
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-command-path.mjs /root/wxg
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-fork.mjs /root/wxg
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-image.mjs /root/wxg
```

Expected tail of each: `ALL CHECKS PASSED`. `test-acp-image.mjs` runs one real
text turn and one real vision turn, and `test-acp-command-path.mjs` two real
turns, so those two spend tokens.

The ACP tests boot dsh with `$DSH_HOME`; dsh rewrites `$DSH_HOME/profiles/<name>/cordis.yml`
at boot, so point it at a writable copy of the profile when the real home is not
writable:

```bash
export DSH_HOME=/root/wxg/.dsh-acp-test   # cp -r /root/.dsh/{profiles,.env,.credentials.yaml,settings.yaml} there
```

## Reapply after an upstream update

```bash
npm pack dsh-acp-paseo@<version> && tar xzf dsh-acp-paseo-<version>.tgz
cd package
patch -p0 < /path/to/patches/0001-acp-session-fork-and-resume.patch
patch -p0 < /path/to/patches/0002-acp-image-prompt-support.patch
patch -p0 < /path/to/patches/0003-acp-prompt-routing.patch
```

## Deploy

The live copy is
`/root/.dsh/profiles/dsh-acp-paseo/node_modules/dsh-acp-paseo/` (`lib/index.js` and
`lib/codec.js`). Paseo spawns one dsh process per agent, so a patched file affects
agents started afterwards — the CVM daemon does not need a restart; running agents
keep the code they booted with.

To install this fork instead of the published package, point the profile manifest
`/root/.dsh/profiles/dsh-acp-paseo/package.json` at this repository (or at a
published build of it) and re-run `dsh plugin --profile dsh-acp-paseo add <spec>`.
Publishing under an owned scope requires bumping `name` and `version` in
`package.json` first.
