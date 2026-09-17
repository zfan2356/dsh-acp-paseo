# dsh-acp-paseo (fork)

Fork of the published npm package [`dsh-acp-paseo@0.1.0`](https://www.npmjs.com/package/dsh-acp-paseo),
patched so Paseo can open a **Side Chat** on a dsh (DeepSeek Harness) agent,
send **screenshot (image) prompts** to an image-capable dsh model, keep
**messages that start with a path** (and native slash commands) working, and
open a persisted session **with its conversation replayed**.

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

## Patch: oversized image normalization

`patches/0005-acp-image-normalization.patch` changes `lib/index.js`,
adds `lib/image-normalizer.js`, and adds `sharp` as a runtime dependency.

DSH deliberately refuses images with an intrinsic side above 2000px because
such an attachment remains in session history and can make later multimodal
requests fail. Retina and phone screenshots commonly exceed that limit even
when their encoded files are small. The bridge now downsizes oversized JPEG,
PNG, and WebP prompt images proportionally before admission. Images already
within the limit keep their original bytes, while malformed, unsupported, or
over-pixel-budget inputs remain unchanged so the attachment store still owns
their normal validation errors.

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

## Patch: conversation replay on attach

`patches/0004-acp-session-load-replay.patch` changes `lib/index.js` only.

Paseo keeps agent timelines in daemon memory, so after a daemon restart the only
surviving copy of a dsh conversation is the session's own event log. Paseo's ACP
client replays history exclusively on the `loadSession` branch of its resume
path (`packages/server/src/server/agent/providers/acp-agent.ts` in the Paseo
fork); the stock bridge advertised only `sessionCapabilities.resume`, so a
resumed dsh agent opened with an **empty chat** while a cursor or codex agent
replayed from its provider. Restarting the daemon exposes this every time: the
agents that were live lose the in-memory timeline they never had to rebuild.

1. `initialize` advertises `agentCapabilities.loadSession`.
2. `session/load` (SDK `loadSession`) resumes the persisted session through
   `ctx.agents.resume` and re-sends its transcript as `session/update`
   notifications before it returns, because Paseo collects updates only while
   its load request is in flight.
3. The live event-to-update mapping moved into one `translateSessionEvent`, used
   by both the streaming handler and the replay, so a replayed conversation
   renders with the shapes it had while it was live. Assistant chunks now carry
   the dsh message id, which is what Paseo groups a message's chunks by.
4. The replay sends the user turns the live path never echoes (Paseo records the
   prompt it submitted), and skips `assistant/chunk` deltas because the
   `assistant/message` that closes the step carries the same text in full.

`session/resume` is unchanged, so a Side Chat still attaches without replaying
the parent context it forked from; Paseo marks side-chat history primed and skips
provider hydration, which is what keeps the inherited turns hidden.

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
- `test-acp-load.mjs` — dependency-free ACP client that writes a hand-built
  session log into an isolated `$DSH_HOME` and proves `session/load` replays it:
  the user turn, the reasoning, the assistant answer and the tool call/result all
  arrive, in order, before the response, and a second process replays the same
  conversation. No dsh process is shared with the real home, so it spends no
  tokens and never touches a live conversation.
- `test-acp-image.mjs` — same client, checks the image capability bit, sends an
  oversized generated PNG to an image-capable model and requires a vision
  answer after normalization, then asserts the text-only-model, audio-block,
  and blank-prompt rejections.
- `test-image-normalizer.mjs` — pure local check that downsizes a 1200×2400 PNG
  to 1000×2000, preserves an in-limit image unchanged, and leaves malformed
  base64 for the attachment store to reject. No dsh process or tokens.

## Verify

```bash
node test-codec.mjs
node test-image-normalizer.mjs
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-command-path.mjs /root/wxg
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-fork.mjs /root/wxg
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-load.mjs /root/wxg
PATH="/root/.local/dsh-paseo/bin:$PATH" node test-acp-image.mjs /root/wxg
```

Expected tail of each: `ALL CHECKS PASSED`. `test-acp-image.mjs` runs one real
text turn and one real vision turn, and `test-acp-command-path.mjs` two real
turns, so those two spend tokens. `test-acp-load.mjs` builds its own session log
and overlays this repository's `lib/` on a copied profile, so it checks the
working tree without spending tokens.

The ACP tests boot dsh with `$DSH_HOME`; dsh rewrites `$DSH_HOME/profiles/<name>/cordis.yml`
at boot, so point it at a writable copy of the profile when the real home is not
writable:

```bash
export DSH_HOME=/root/wxg/.dsh-acp-test   # cp -r /root/.dsh/{profiles,.env,.credentials.yaml,settings.yaml} there
```

`test-acp-load.mjs` takes its isolated home from `DSH_TEST_HOME` (default
`/root/wxg/.dsh-acp-test`) and creates it on first run, because `DSH_HOME`
already points at the real home in a dsh session's environment.

## Reapply after an upstream update

```bash
npm pack dsh-acp-paseo@<version> && tar xzf dsh-acp-paseo-<version>.tgz
cd package
patch -p0 < /path/to/patches/0001-acp-session-fork-and-resume.patch
patch -p0 < /path/to/patches/0002-acp-image-prompt-support.patch
patch -p0 < /path/to/patches/0003-acp-prompt-routing.patch
patch -p0 < /path/to/patches/0004-acp-session-load-replay.patch
patch -p0 < /path/to/patches/0005-acp-image-normalization.patch
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
