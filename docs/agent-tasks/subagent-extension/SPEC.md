# Specification: Cooperate subagent extension

## Status
Approved for implementation.

## Context

`cooperate` is a private Pi extension for delegating work from the TUI-connected main agent to reusable, independently configured Pi subagents. A subagent may create its own permitted subagents, producing a bounded tree of work. The extension must preserve Pi's normal agent behavior and resources while adding strict capability boundaries, persistent child context, structured cancellation, asynchronous continuation, and a deliberately compact TUI.

The main Pi agent is depth 1. A **Subagent** is a live binding of an **Agent Definition** (identity and capabilities) to a **Session** (persistent conversation context). Definitions and Sessions are deliberately independent: the same Session may be resumed sequentially under different Definitions, but may have only one live binding at a time.

## Goals and non-goals

### Goals

- Let an agent run configured subagent types synchronously or asynchronously through one `subagent` tool.
- Enforce exact tool and child-Definition allowlists at every depth.
- Support nested work up to a configured maximum depth.
- Persist and resume child Sessions while respecting Pi history branches.
- Keep the main request Working until the main loop and every descendant loop have settled.
- Isolate sibling failures while cascading cancellation down the failed or cancelled subtree.
- Make active work observable and cancellable through polished tool renderers and `/subagents`.

### Non-goals

- Publishing the extension or designing a public compatibility surface.
- Forking or automatically copying the creator's conversation into a new subagent Session.
- A concurrency limit, work queue, or scheduler beyond `maxDepth`.
- Invocation-time overrides for model, thinking level, tools, or depth.
- Persistent runtime IDs, result caches, or automatic restart after a crash.
- A persistent-Session management UI, Session deletion, or a Session-inspection tool action.
- Process or VM isolation between extension modules.
- Hot-reloading configuration or Definitions without Pi `/reload`.

## Required behavior

### Configuration and Definition catalog

The global configuration file is `~/.pi/agent/cooperate/config.json`. A missing file uses:

```json
{
  "maxDepth": 3,
  "gcOrphanSessions": true
}
```

`maxDepth` must be an integer of at least 1. Unknown fields, malformed JSON, or invalid values reject configuration with the source path and reason.

Agent Definitions are direct, non-recursive `.md` files in `~/.pi/agent/cooperate/subagents/`. A missing directory is an empty catalog. Each file has YAML frontmatter and a nonempty Markdown body:

- `name`: required, authoritative, case-sensitive, and matched by `^[A-Za-z0-9_-]+$`.
- `description`: required and nonempty; shown to a potential creator.
- `tools`: optional comma-separated exact tool-name allowlist; defaults to empty.
- `subagent_agents`: optional comma-separated exact Definition-name allowlist; defaults to empty.
- `model`: optional exact `provider/modelId`; split on the first slash, with additional slashes allowed in the model ID.
- `thinking`: optional valid Pi thinking level.
- Markdown body: required system instructions for the Definition.

Whitespace is trimmed from comma-separated entries. Empty or duplicate entries, duplicate Definition names, unknown frontmatter fields, unresolved Definition references, unavailable tools, malformed model references, or models absent from Pi's registry invalidate the entire catalog. Tools are validated again when a child runtime is created. No configured tool is silently omitted and no tool is implicitly added.

A nonempty `subagent_agents` requires `subagent` in `tools`. A Definition may include `subagent` with an empty child allowlist; it can then list, wait for, or cancel direct children but cannot run a new child. The main agent may use every current Definition. A child may run only the Definitions listed by its own Definition. The `subagent` tool description and schema expose only the Definitions available to that caller, including their descriptions.

Configuration and the catalog reload only with the extension. An invalid catalog prevents a partially valid catalog from becoming active. Existing child Session files survive Definition changes or deletion, but every new invocation requires a currently valid Definition.

### Child Pi runtime

Each live Subagent is an in-process, independent, headless Pi `AgentSessionRuntime`, with its own Agent, SessionManager, extension runtime, and tool registry. Child runtimes load the same normal Pi resources as a fresh Pi Agent in the same working directory: global and project context files, skills, system and append-system prompts, enabled extensions, providers, and their registered tools. Extension factories and lifecycle events run in each runtime. Module imports and module-scope globals remain process-shared.

The child's final active tool set is exactly the Definition's `tools` allowlist. Tool registration failures or unavailable configured tools fail the invocation rather than weakening the allowlist.

The Definition Markdown body is added through Pi's append-system-prompt resource slot. Existing append-system prompts are retained in their existing order and the Definition body is appended after them. Consequently, the Definition body appears where Pi normally places append-system content, before project context, skills, and current-working-directory sections; it is not appended to the fully assembled prompt.

A newly created Session receives only the explicit `task` as its user message. It does not receive the creator's conversation, system prompt, or tool history. A resumed Session retains only its own existing history plus the new task.

Model selection for every invocation is:

1. The Definition's explicit registered `provider/modelId`, if present.
2. Otherwise, the creator's current model at invocation time.

Thinking selection never inherits the creator's level. It is:

1. The Definition's explicit value, if present.
2. Otherwise Pi's global `defaultThinkingLevel`, if configured.
3. Otherwise `medium`.

Pi then clamps or disables the selected thinking level according to model capability. Model and thinking entries previously stored in the Session JSONL do not override this invocation-time resolution. Missing authentication fails at invocation time without invalidating the catalog.

### Depth and identity

The TUI-connected main agent is depth 1. Each child increments depth by one. A `run` that would exceed `maxDepth` is rejected before creating or locking a Session.

Every live binding receives a memory-only `subagentId` consisting of exactly eight lowercase hexadecimal characters. Generation checks for collisions among active IDs. It is distinct from the durable Session UUID and is cleared on terminal completion, interrupt, tree or Session replacement, reload, exit, or restart. Finished IDs have no durable meaning.

A live Subagent is `running` while its own loop is active and `waiting` after its own loop ends while descendants remain active. A Session has no execution state; it is `locked` exactly while bound to a live Subagent. One Session cannot be bound to multiple live runtimes.

### Session ownership, visibility, and storage

A parent Session directly owns each child Session it creates. The main Pi Session is the root Session for ownership purposes. A parent can discover, resume, wait for, or cancel only its direct children; it cannot address a descendant through an intermediate child.

Creation ownership is persisted as a Pi custom entry in the parent Session. That custom entry is also the branch-visibility anchor: a child is visible only when the creation entry belongs to the parent's current `getBranch()` path. No separate message anchor is stored. Compaction must not remove this relationship. Pi's default tree view may hide the bookkeeping entry, while its All view may show it as a custom entry.

Child Sessions use native Pi JSONL and native `SessionManager.create()` UUIDv7 IDs and filenames. They are stored flat beneath the TUI-connected master Session:

```text
~/.pi/agent/cooperate/sessions/<master-session-id>/<native-session-file>.jsonl
```

Nested Session files use the same master directory; nesting is represented by ownership entries rather than filesystem nesting. A child Session JSONL does not depend on the master Session ID. The effective identity is `(masterSessionId, childSessionId)`, although tool calls use the child ID alone because they are resolved within the current master namespace.

Resuming a master Pi Session makes branch-visible children resumable. A process crash does not restart prior work; memory-only bindings disappear, incomplete Sessions remain unlocked and resumable, and no terminal notification is synthesized.

`list-sessions` reports only direct, branch-visible Sessions and only these fields:

- `session`: full native UUIDv7.
- `locked`: whether it has a live binding.
- `task`: compact preview of the latest real user message, excluding custom completion messages.
- `result`: compact preview derived by the final-text rule for the corresponding latest run, or literal `<none>`.
- `file`: absolute path resolved in the current master directory.

The output observes Pi's 50 KB or 2000-line tool-output ceiling. Historical tool output may contain an old absolute path after a master fork; a fresh listing is authoritative.

### Tool contract

The extension registers one dynamic tool named `subagent` with exactly these action shapes:

```ts
{ action: "run", agent: string, task: string, sessionId?: string, async?: boolean }
{ action: "list-subagents" }
{ action: "list-sessions" }
{ action: "wait", subagentIds: string[] }
{ action: "cancel", subagentId: string }
```

For `run`:

- `agent` must be one of the caller's currently allowed Definitions.
- `task` must be nonempty.
- Omitted `sessionId` creates a new directly owned Session and persists ownership before work is exposed.
- A supplied `sessionId` must identify a direct, branch-visible, unlocked Session.
- `async` defaults to `false`.
- There are no model, thinking, tool, context-fork, or depth overrides.

A blocking run keeps the tool call pending until the target's complete subtree terminates. On success it returns the extracted final result in the tool result and never sends a custom completion message. On failure it returns an error tool result containing the Session ID and reason; the failed Session remains resumable.

An asynchronous run returns its new `subagentId` and Session ID once startup succeeds. Its terminal success, failure, or explicit cancellation is subsequently delivered exactly once as a custom completion message, never as a delayed tool result.

`list-subagents` returns only the caller's direct active bindings, with enough identity, Definition, Session, task, state, and elapsed information to use `wait` or `cancel`. It does not return finished bindings.

`wait` requires a nonempty list of unique IDs. Every ID must identify a direct active binding when the action begins or the whole action errors. It captures those bindings and waits for all of them to reach any terminal state. Each asynchronous completion still queues its normal independent custom message. After all captured bindings terminate, `wait` returns only a terse successful acknowledgement; it does not aggregate results or convert child failures into a wait-tool failure. An ID that completed before `wait` begins is not valid.

`cancel` accepts one direct active ID, cancels its entire subtree, waits until that subtree has stopped, and returns without an extra success line. It notifies the surviving direct parent once about the explicitly cancelled target; cascade-cancelled descendants do not generate duplicate notifications.

### Result extraction and notifications

A run result is derived only from that run's terminal assistant message. Within that message, only its last nonempty `text` content block is used. Earlier text blocks, earlier assistant messages, thinking, tool calls, tool results, task messages, and history are excluded. If the terminal assistant message has no nonempty text block, the result is literal `<none>`.

The parent-facing copy is truncated to Pi's 50 KB or 2000-line limit. The full child transcript and any full text remain in the child JSONL.

An asynchronous terminal notification is a persisted Pi custom message that participates once in model context. Its model-visible content includes the Definition, terminal state, Session ID, and successful final output or failure/cancellation reason. It omits the expired `subagentId`. Renderer-only details may carry presentation data such as elapsed time.

If the parent loop has not reached its logical end, completion is delivered as `steer`. If the parent's own loop has ended and its aggregate `agent_end` handler is waiting for descendants, completion is delivered as `followUp` so the parent loop continues. Completions are neither debounced nor coalesced; each asynchronous child queues one message naturally. A completion that races asynchronous startup must not be delivered before the starting `run` tool result has been committed.

### Structured lifecycle, failure, and cancellation

An agent's structured scope includes all descendants. Cooperate keeps an `agent_end` handler pending while that scope contains active descendants, preserving Pi's native streaming/Working lifecycle. The root Working state ends only after the main loop and all descendant loops have ended.

Failure is isolated horizontally and cascades vertically:

- A failed child cancels and awaits all of its descendants.
- Its siblings continue unaffected.
- The surviving direct parent receives only the failed child's failure report.
- Cancellation noise from descendants is suppressed.
- A blocking failed child makes its `run` tool result an error.
- An asynchronous failed child sends one failure notification.

A main UI interrupt, tree navigation, Session switch, new Session, master fork or clone, extension reload, or exit cancels and awaits the entire active tree. Those lifecycle-wide cancellations send no completion notifications. An explicit tool/UI cancellation follows the notification rule described above. Cleanup and runtime disposal are idempotent.

### Master fork, clone, and orphan cleanup

After Pi successfully performs `/fork` or `/clone`, the new master Session receives an independent copy of the old master's entire child-Session directory. The old tree is fully stopped and all child runtimes are disposed before copying begins. IDs inside copied JSONLs are not rewritten; the new master namespace makes the copies independent and separately lockable. Branch-hidden files may be copied but remain undiscoverable unless an ownership entry is on the copied active path.

Copying uses a temporary sibling directory followed by atomic rename. It never merges into an existing destination. A copy failure leaves the source untouched, removes any incomplete temporary destination, and reports a clear initialization error rather than activating partial state.

When `gcOrphanSessions` is enabled, startup identifies master directories whose corresponding Pi master Session no longer exists and deletes each complete orphan directory. It uses the system `trash` command when available and falls back to recursive removal. Cleanup runs after any required fork/clone copy so the source is not collected prematurely.

### TUI presentation

The extension does not depend on `ui-shell`; it uses Pi theme roles so that `ui-shell` may restyle normal accent parameters externally.

Tool-call headers are exactly:

- `subagent run <agent>`
- `subagent run <agent> (async)`
- `subagent list-subagents`
- `subagent list-sessions`
- `subagent wait <id>, <id>`
- `subagent cancel <id>`

`subagent` and the action use the tool-title color, arguments use Pi accent, and `(async)` is muted. Async run's collapsed result is only `started <subagentId>`. List actions collapse to counts. Successful wait and cancel add no result line. Expanded views expose the complete model-visible tool result.

A blocking `run` receives live `onUpdate` details and renders the complete invocation subtree, excluding unrelated siblings. Hierarchy, Definition, state, elapsed time, and a width-aware task preview are visible. State marks are an animated spinner for `running`, `◌` for `waiting`, `✓` for `finished`, `×` for `failed`, and `–` for `cancelled`. The terminal tree remains attached to the completed tool call. Expanded mode additionally shows full tasks, IDs, model, thinking, complete model-visible results, and errors.

Custom completion messages have a bold `[subagent]` title. Their collapsed text is exactly one of:

- `Subagent <agent> finished (ctrl+o to expand)`
- `Subagent <agent> failed (ctrl+o to expand)`
- `Subagent <agent> cancelled (ctrl+o to expand)`

Expanded success shows the final reply; expanded failure or cancellation shows its reason. Session ID and elapsed time are muted. The renderer responds to Pi's normal expanded state rather than introducing a separate keybinding.

The `/subagents` command opens a bordered overlay inspired by the local `model-preset` extension. It omits the main root and displays the complete current active tree only. Rows show hierarchy, Definition, `running` or `waiting`, elapsed time, and a width-aware task preview. Selection uses Pi accent. Enter opens a detail view; Escape returns to the list, then closes the overlay. Details show full task, state and elapsed time, model, thinking, depth, subagent ID, Session ID, and direct-child count.

The detail footer is `c cancel subtree   esc back`. Pressing `c` asks `Cancel <agent> and its N descendants?` with No selected by default. Confirmation waits for the subtree to stop and returns to the refreshed list. State changes request rerender while the overlay is open. An empty list displays `No active subagents`. No launch, resume, inspect, delete, or persistent-Session operation is available in the overlay.

## Design decisions

- Use in-process Pi runtimes rather than subprocesses so Sessions, cancellation, runtime events, and structured scopes can be coordinated directly.
- Use native Pi JSONL and custom entries rather than a parallel transcript or ownership database.
- Treat Session identity as master-namespaced so master fork/clone can copy files without rewriting UUIDs or immutable history.
- Keep a single action-discriminated tool rather than separate spawn, list, wait, and cancel tools.
- Hold Pi's real `agent_end` lifecycle rather than spoofing a Working indicator.
- Keep runtime IDs transient and terminal delivery message-based; do not build a result cache.
- Load normal Pi resources in every child, then enforce the Definition allowlist as the exact active tool set.
- Use Pi theme primitives and standard expanded state rather than coupling to the user's separate UI patch extension.

## Constraints

- Implementation targets the Pi 0.83.0 extension and SDK behavior used to approve this specification.
- The project is an ESM TypeScript Pi package. Pi core imports are peer dependencies as required by Pi package conventions.
- All required verification must run without a real model request, network service, credentials, or interactive terminal operation. Runtime, lifecycle, filesystem, and TUI behavior therefore require deterministic test adapters or fakes.
- Tool and copied result output must obey Pi's 50 KB or 2000-line truncation limits while preserving full child JSONL data.
- Session shutdown, cancellation, fork preparation, and disposal must be safe under repeated or racing calls.

## Acceptance criteria

- Missing valid configuration produces the documented defaults, while every specified invalid configuration or Definition condition rejects the whole catalog with a path and reason.
- The dynamic tool exposes only caller-allowed Definition names and descriptions, and a child runtime receives exactly its configured tool names.
- A child loads normal Pi resources, preserves existing append-system prompts, inserts its Definition in the native append slot, receives only its explicit task, and resolves model and thinking according to the required precedence.
- A blocking direct child can create and persist a native Session, return only the final text block, and later resume the same Session under any currently permitted Definition.
- Direct ownership and Session discovery follow the active Pi branch and survive compaction and master resume.
- Nested runs enforce depth and Definition permissions; a child failure cancels only its descendants while siblings continue.
- Main interruption and every specified Session lifecycle transition stop and dispose the complete tree without completion-message noise.
- Async runs return promptly, deliver exactly one terminal message, continue an idle waiting parent, and keep native Working active until all descendants settle.
- `list-subagents`, `list-sessions`, `wait`, and `cancel` enforce direct-child visibility and their specified validation, waiting, and result semantics.
- Master `/fork` and `/clone` create independent byte-equivalent child Session copies under the new namespace without ID rewriting; failure cannot leave an active partial destination.
- Enabled orphan GC selects only missing master Sessions and uses the specified trash/fallback behavior.
- Tool renderers, completion renderers, and `/subagents` match the specified compact/expanded information and interaction behavior at narrow and wide terminal widths.
- The complete automated test suite, type check, package dry run, and offline Pi package-load smoke check pass without model credentials or manual interaction.
