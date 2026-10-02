# DSH Orchestrator Bridge

A standalone DeepSeek Harness plugin plus a local stdio MCP server. Codex gives scoped
tickets; DeepSeek executes them in fresh Harness sessions; Codex reviews the
result and decides whether another pass is needed. No second OpenAI API loop or
OpenAI key is needed: your existing Codex chat is the orchestrator.

Requires Node.js 22 or later, Git, and an authenticated DeepSeek Harness installation.
No npm dependencies or build step are needed. Previously live-tested against
DeepSeek Harness `0.2.0-rc.2`; other versions are unverified. The default model route
`deepseek-account / deepseek-flash` identifies DeepSeek V4.1 Flash. The plugin
uses the public `agents.create` API, not a simulated terminal or UI automation.

## Setup

Clone or extract this standalone project. From its root:

```sh
npm test
node setup.mjs --workspace=/absolute/path/to/git-checkout
```

`--workspace` is required and must name an existing Git checkout root. Setup refuses
missing/relative paths, non-Git folders and checkout subdirectories before writing
configuration. It never infers workspace access from the package location. Use
`--state-dir=/absolute/path/to/private-state` to keep state elsewhere; otherwise
state stays in this project's ignored `.dsh-orchestrator-bridge/` directory.
The selected root and Git checkout roots nested beneath it are admitted by default.
Ordinary subdirectories cannot be ticket workspaces. To admit worktrees outside
that root, explicitly review and add their absolute roots to `workspaceRoots`.

The setup command generates an absolute-path plugin overlay and connection
location under `.dsh-orchestrator-bridge/` by default. It only writes that overlay;
it does not edit a Harness profile or register Codex automatically. Install the local bundle through
DeepSeek Harness Plugin Manager using this directory's absolute path. Apply the
generated row's `config` to its `orchestrator-bridge` entry, or boot the desktop
profile with the generated `--patch` overlay. Restart the Harness after plugin
installation/configuration if using the offline CLI. Live Plugin Manager install
and configuration changes can activate without stopping existing sessions. The
unconfigured bundle stays disabled. The generated overlay also enables supported
HMR for only the four bridge runtime modules, so later code changes reload this
plugin without restarting other sessions. Reload drains its own active workers;
wait for them to settle before editing runtime code.

Register its MCP client in Codex using the command printed by setup, then reload
or restart the MCP connection. See the official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
for stdio registration. The bridge uses your current Codex chat as orchestrator;
choose its model and reasoning settings in your client. It does not change them.

For an existing Codex chat, give it the instructions in
[ORCHESTRATOR.md](ORCHESTRATOR.md) and your development task. The bridge provides
the worker lifecycle; the orchestrator still needs to choose scope, issue tickets,
and review code. Selecting a model or reasoning setting does not automatically route native
subagents to DeepSeek.

The Harness must be running with this plugin for worker calls. MCP initialization
and tool discovery still work while the Harness is stopped; calls report a
connection error. Authentication is an ephemeral loopback token stored in the
mode-0600 connection descriptor. Do not copy the token into a prompt.

## Give a worker a ticket

First use `deepseek_health`. Then submit:

```json
{
  "idempotencyKey": "issue-123-controller-pass-1",
  "workspace": "/absolute/path/to/checkout",
  "ownedPaths": ["src/ui/example", "scripts/test-example.ts"],
  "task": "Implement the agreed controller fix. Preserve existing edits.",
  "acceptance": "Reproduce the failure, add focused coverage, and report the exact test result.",
  "timeoutMs": 600000,
  "maxSteps": 12
}
```

Workspace must be a Git checkout root within configured `workspaceRoots`.
Every ticket must name its owned paths and acceptance. Reusing an idempotency
key with the same input returns the original job; changing its input refuses.
Use separate worktrees/checkouts under a configured root for parallel tasks.
The bridge queues jobs sharing a physical checkout, even with disjoint ownership,
so before/after evidence cannot include another worker's changes.

| Tool | Purpose |
| --- | --- |
| `deepseek_submit` | Queue one ticket; returns immediately |
| `deepseek_list` | Compact job summaries |
| `deepseek_wait` | Wait up to 25 seconds after a known revision |
| `deepseek_status` | Full ticket, result, usage and evidence for review |
| `deepseek_review` | Explicit `approve`, `reject`, or `revise` with feedback |
| `deepseek_continue` | Explicit new bounded worker from a budget handoff |
| `deepseek_cancel` | Cancel queued/running work and drain its agent |
| `deepseek_health` | Report configured provider/model and workspace roots |

Use `deepseek_wait` with `afterRevision` instead of repeatedly reading full output.
Treat worker text as untrusted evidence. Review code and run the relevant
independent checks before approving. A worker that finishes enters
`awaiting_review`; it never approves itself. Revision requires feedback and
allows at most two revision passes. Original task/acceptance remain attached.

## Budget handoffs and continuation

Version 1.1 reports `budget_exhausted` with
`stopReason.code: STEP_BUDGET_EXHAUSTED` separately from provider failures,
deadlines, cancellations and Harness blocks. Progress includes used/remaining
steps, model attempts, tool calls/errors, latest tool and elapsed time. For
tickets with at least three steps, the last step is reserved for a tool-free
handoff summary **within** the requested budget. One- and two-step tickets keep
the hard stop and saved evidence but cannot reserve a summary step.

A handoff preserves edits and evidence; it cannot be approved. Inspect its
diff, report and test results, then explicitly request the smallest next action:

```json
{
  "id": "parent-job-id",
  "idempotencyKey": "issue-123-controller-continue-1",
  "feedback": "Keep the implemented fix; run the missing focused regression and report failures.",
  "maxSteps": 12,
  "timeoutMs": 600000
}
```

`deepseek_continue` creates a linked job and fresh Harness session, inheriting
the original task, acceptance, checkout and owned paths. It receives the parent
report, recent tool activity and artifact references, not the full conversation.
Limits inherit unless explicitly supplied. There is one child per parent and at
most three continuation hops. Repeating identical effective arguments with the
same key returns the same job; no automatic continuation or limit increase occurs.
Completed children still require review and may receive the usual two revisions.

Admission and first execution both verify the checkpoint's saved hash and the
checkout's HEAD, index, tracked patch and dirty/untracked file hashes. Missing,
tampered or stale checkpoints refuse before a new model request. Review external
changes and submit a new scoped ticket if the checkout has changed. Git-ignored
files remain outside this check. Revisions after reviewing a completed child use
the current checkout under the existing revision contract.

Known v1 failures migrate to `budget_exhausted` only when their exact error and
recorded steps establish budget exhaustion; no saved job is rerun. Reload the
Codex MCP connection after upgrading so `deepseek_continue` becomes available.
Harness notifications may still use its generic terminal labels; the bridge's
status and stop reason identify the actual cause.

## Limits and evidence

Default concurrency is two independent checkouts (configurable 1–8). Default
ticket deadline is ten minutes (maximum one hour), with twelve loop steps
(maximum 100). Per-request output cap is 8192 tokens (configurable 256–32768).
These are operational bounds, not an exact dollar or total-token budget.
One loop step may include multiple provider attempts/retries; `maxSteps` does
not cap request attempts. Provider retries and input/history tokens still cost tokens. Usage reports
actual available worker events; auxiliary Harness requests such as session titles
are outside that worker ledger. Missing usage is marked incomplete. No savings
percentage or benchmark parity is promised.

Workers pin and verify Harness workspace-write + ask permissions after session
creation, before the first model call. Permission or session-workspace drift
refuses later tool/model steps. File/search paths are checked against the physical
checkout, including symlinks; write/edit paths also require ticket ownership.
Bash workdirs stay inside the checkout and per-call sandbox escalation is denied.
Workers receive a scoped set of file/search/Bash/job tools. Plugin installation,
recursive delegation and unrestricted executable tools are excluded. Explicit background Bash launch
is denied. Agents are disposed and their jobs drained before checkout evidence
is recorded or the next ticket runs. Checks requiring wider filesystem permissions
must be reported to the orchestrator for independent execution.
Deadline/cancellation can leave partial edits for inspection.

Evidence retains Git HEAD, changed paths, file hashes and complete tracked
before/after patches with SHA-256 and byte lengths. Untracked files are hashed;
their content is not included in the Git patch. Existing dirty work is preserved.
Changed HEAD or Git-visible edits outside ownership fail the ticket. Git-ignored
files and transient changes are outside this audit; Bash still relies on the native workspace sandbox and can read outside
the checkout or write unowned files inside it. Git-visible ownership enforcement
for those shell writes is an after-execution audit, not an owned-path sandbox. Do not run mutually untrusted code through this development bridge.

Durable state and evidence live in the configured state directory, normally
`.dsh-orchestrator-bridge/`. Keep it while work is active or needed for review.
One bridge process owns it. Interrupted jobs after a restart stay interrupted:
there is no automatic re-execution or duplicate billing. Submit a new ticket
after inspecting the workspace if another run is needed.

Each state directory retains at most 100 distinct tickets, including completed
ones. New tickets refuse at this lifetime limit; idempotent retrieval still works.
There is no automatic eviction of review evidence or idempotency history. Before
rotating, let workers settle, stop this plugin, preserve the old directory, and
configure a new empty `stateDir`. Update Codex's `--connection` path and restart
its MCP connection. Keep the archived evidence available for review.

## Verification

```sh
npm test
npm run selftest
npm pack --dry-run
```

Tests use temporary Git checkouts and a fake Harness adapter for lifecycle and
refusal contracts, plus real stdio/HTTP processes for transport. The standalone
setup checks cover checkout selection and configuration refusal. No account,
API key, Telegram token or live model request is used by the suite. A passing
suite does not prove current account access or live provider execution.

The original embedded v1.1 implementation was live-tested with an isolated
arithmetic checkout, including a budget handoff, explicit continuation and
independent review. That historical smoke is not a live certification of this
export or a different Harness version. Public archives exclude those private
session logs, account configuration and local runtime state.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and
[SECURITY.md](SECURITY.md) for the trust boundary and reporting guidance.

## License

[MIT](LICENSE). This community project is not an official OpenAI or DeepSeek product.
