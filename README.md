# Multica DSH Runtime

Private, out-of-tree runtime bridge between Multica and the public
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It exposes
a versioned JSONL protocol over stdio and composes over
`@deepseek-ai/dsh-base`. It does not require changes to DeepSeek Harness.

![DeepSeek Harness runtime online in Multica](docs/images/multica-dsh-runtime.png)

## Privacy

- This repository contains only the Multica integration layer. It does not
  vendor or redistribute DeepSeek Harness source code.
- Never commit API keys, MCP secrets, session logs, or generated profiles.
- DSH telemetry is disabled by the bundle patch.
- stdout is protocol-only; diagnostics go to stderr.

## Local development

The DSH packages used by this plugin are public npm packages. This checkout is
currently validated against `@deepseek-ai/dsh@0.2.1-rc.2` and its matching
`@deepseek-ai/dsh-*` package family. `engines.dsh` declares the supported range
(`>=0.2.1-rc.2 <0.3.0`); DSH refuses to load the bundle outside it. DSH 0.1.x
needs the previous `0.1.0-private.1` build.

```bash
pnpm install
pnpm check
pnpm build
```

Install the local bundle into a DSH profile after building it:

```bash
dsh plugin --profile multica add /absolute/path/to/multica-dsh-runtime
```

The plugin supports:

```bash
dsh --profile multica --probe
dsh --profile multica --list-models
dsh --profile multica --stdio
```

Multica discovers the profile only after `--probe` returns protocol version 1.
For a non-standard DSH installation, point the daemon at its launcher:

```bash
export MULTICA_DSH_PATH=/absolute/path/to/dsh
```

The runtime contract includes:

- model and thinking-level discovery from DSH itself;
- committed text, reasoning, tool, result, and token-usage events;
- cooperative cancellation and durable session resume;
- canonical Multica MCP configuration translated to DSH stdio or
  streamable-HTTP clients;
- per-runtime/agent session roots supplied by the Multica daemon;
- headless one-shot approvals;
- ask/plan parity: `ask_user_question` and `exit_plan_mode` park the run on an
  outbound `question` frame (advertised as `capabilities.questions`) and
  resolve with the daemon's inbound `answer` command carrying the human's
  reply; an answer for an unknown or settled question is ignored with a stderr
  diagnostic, and cancel aborts the wait;
- steer and queue: inbound `steer` reaches the agent's inbox at its next step
  boundary and inbound `queue` becomes the run's next turn, advertised as
  `capabilities.steer`/`capabilities.queue`; each delivery is confirmed on the
  outbound `inbox_state` frame — `accepted`, then `applied` at that boundary,
  or `rejected` with a reason — a command naming another request or a finished
  run never reaches the agent (which keeps `cancel` per session), and a
  malformed line is reported as `protocol_error` without ending the run;
- summarize: inbound `summarize` compacts an idle session and reports the
  summary on a `summary` frame (`capabilities.summarize`); an optional
  `max_tokens` (positive integer, sent only to a bridge advertising
  `capabilities.summarize_max_tokens`) caps the summary size. If the summary's
  token estimate (`ceil(length / 4)`) exceeds it, no `summary` frame is sent
  and the run ends `failed` with error code `DSH_SUMMARY_OVER_CAP`, and this
  bridge does not flush the compacted session; equal to `max_tokens` is within budget;
- narrowly forwards only Multica's server-minted `mat_` task token into DSH's
  otherwise credential-scrubbed shell, so in-task `multica` commands retain
  task attribution without exposing model-provider credentials.

The local `.local/` tree is ignored. It may hold an isolated DSH home and a
development launcher, but neither belongs in source control.

`DEEPSEEK_API_KEY` is read by DSH's credential provider at process runtime. It
must not be stored in this repository.
