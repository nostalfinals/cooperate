# Implementation Plan: Cooperate subagent extension

## References

- Specification: `SPEC.md`
- Pi extension API: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi SDK: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Pi TUI: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Pi package conventions: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- SDK full-control example: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/12-full-control.ts`
- Built-in subagent example: `/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`
- Overlay reference: `~/.pi/agent/extensions/model-presets/`
- Tool-rendering reference: `~/.pi/agent/extensions/ui-shell/`

## Progress

- [x] Slice 1 — Load a strict Definition catalog
- [x] Slice 2 — Run and resume a blocking direct subagent
- [x] Slice 3 — Move Definition discovery into the prompt and tool action
- [x] Slice 4 — Coordinate a nested structured runtime tree
- [x] Slice 5 — Run asynchronously and manage direct children
- [x] Slice 6 — Preserve Session semantics across Pi lifecycle changes
- [x] Slice 7 — Deliver the complete TUI presentation

## Current codebase state

Slices 1 through 6 are implemented on `main`. The repository is now an ESM TypeScript Pi package with strict catalog loading, blocking and asynchronous structured child runtimes, native Session persistence/reuse, branch-aware ownership, exact tool activation, prompt/model resolution, caller-scoped Definition discovery, direct-child management, gated custom completion delivery, lifecycle cancellation, atomic fork/clone namespace copying, orphan cleanup, and deterministic Vitest coverage. The current source is organized around `src/catalog.ts`, `src/continuation.ts`, `src/coordinator.ts`, `src/index.ts`, `src/lifecycle.ts`, `src/prompt.ts`, `src/runtime.ts`, `src/sessions.ts`, and `src/subagent.ts`; the matching tests cover catalog/package behavior, blocking and async runs, nested coordination, continuation routing, management actions, prompts, Definition discovery, Sessions, Working lifecycle, branch visibility, Session lifecycle, master forks, and orphan collection.

The implementation targets the locally installed Pi 0.83.0 APIs. Pi provides the remaining primitives: structured system-prompt options in `before_agent_start`, `DefaultResourceLoader` overrides, independent SDK AgentSessions, native JSONL `SessionManager`, custom entries and messages, awaited extension lifecycle handlers, abort signals, dynamic tool renderers, and overlay TUI components.

Continue retaining explicit seams between pure domain coordination and Pi/filesystem adapters so tests can exercise required behavior without provider calls, credentials, sleeps, or a real terminal. Add coordinator or UI modules only when their slices need them; do not reorganize completed modules merely to match the original suggested layout.

## Execution roadmap

```mermaid
flowchart LR
    S1["1. Catalog"] --> S2["2. Blocking run and reuse"]
    S2 --> S3["3. Definition discovery"]
    S3 --> S4["4. Nested structured tree"]
    S4 --> S5["5. Async coordination"]
    S5 --> S6["6. Persistence lifecycle"]
    S5 --> S7["7. TUI"]
    S6 --> V["Final verification"]
    S7 --> V
```

## Slices

### Slice 1 — Load a strict Definition catalog

**Status:** Complete

**Outcome**

`cooperate` is a loadable local Pi package with a deterministic configuration and Definition catalog. Valid Definitions become the caller-facing dynamic catalog; invalid input fails atomically with actionable source diagnostics.

**Completed work**

- Added the private ESM Pi package scaffold, Pi 0.83.0 peer/development metadata, TypeScript and Vitest configuration, and package lockfile.
- Added strict configuration and direct Definition discovery with atomic validation of frontmatter, names, lists, tools, child references, models, thinking levels, and preserved Markdown bodies.
- Added caller-scoped Definition projections and agent schemas plus session-scoped extension initialization and idempotent shutdown state.
- Validation: `npm test -- test/catalog.test.ts test/package.test.ts` (29 tests passed); `npm run typecheck` (passed); `npm pack --dry-run` (passed, 3 package files); `PI_OFFLINE=1 pi -e . --help` (passed).
- Deviations: None.

**Scope**

- Add the ESM TypeScript package manifest, Pi extension manifest entry, TypeScript configuration, Vitest configuration, and npm scripts.
- Declare Pi core packages as `peerDependencies: "*"` and use Pi 0.83.0-compatible development types.
- Add an extension entry point with session-scoped initialization and idempotent shutdown boundaries.
- Resolve `~/.pi/agent/cooperate/config.json` and the direct `subagents/*.md` catalog.
- Parse YAML frontmatter and Markdown bodies, apply defaults, and enforce every catalog constraint in the specification.
- Validate model references against Pi's model registry and tool names against the complete registered tool catalog.
- Derive caller-specific Definition projections and constrained `agent` schemas without mutating the global catalog.
- Establish test fixtures and fakes for paths, tool metadata, model registry data, extension context, and cleanup.

**Implementation notes**

- Treat this as the one enabling slice: strict catalog resolution and deterministic test seams are prerequisites for every meaningful run path.
- Keep parsed configuration, validated Definitions, and caller-visible Definition projections as separate types.
- Preserve Definition body bytes after frontmatter parsing except for the required nonempty check; do not reinterpret Markdown.
- Report all source paths as resolved paths. Reject the complete catalog rather than retaining valid files beside invalid files.
- Do not ask for or probe model authentication during catalog loading.
- Avoid module-scope lifecycle state because the same extension factory will run in multiple child runtimes.

**Validation**

- `npm run typecheck` — proves the package and extension entry compile against the targeted Pi APIs.
- `npm test -- test/catalog.test.ts test/package.test.ts` — proves defaults, strict JSON/frontmatter validation, exact references, model/tool validation, atomic failure, and package metadata without loading a model.

**Dependencies**

- None.

### Slice 2 — Run and resume a blocking direct subagent

**Status:** Complete

**Outcome**

The main agent can run one direct child synchronously, receive only its terminal text result, persist the child as native Pi JSONL, list it on the owning branch, and resume it under any currently permitted Definition.

**Completed work**

- Registered the complete caller-constrained action schema and implemented blocking `run`, active direct-child listing, and branch-visible native Session listing.
- Added native master-namespaced Session creation/opening, durable parent ownership entries, branch visibility, one-live-binding locks, Definition-independent resume, and idempotent shutdown cancellation.
- Added the headless Pi child adapter with normal resource loading, append-slot Definition injection, invocation-time model/global-thinking resolution, extension binding, exact tool revalidation, task-only prompting, disposal, and caller abort propagation.
- Added terminal-assistant final-text extraction, compact Session previews, and shared Pi-ceiling truncation while preserving complete native child transcripts.
- Validation: `npm test -- test/blocking-run.test.ts test/sessions.test.ts test/prompt-resolution.test.ts` (13 tests passed); `npm run typecheck` (passed); full `npm test` (42 tests passed); `npm pack --dry-run` (passed, 6 package files); `PI_OFFLINE=1 pi -e . --help` (passed).
- Deviations: Pi 0.83 defers a newly allocated Session's first JSONL write until an assistant response. Creation therefore writes the header returned by `SessionManager.create()` immediately and reopens it through `SessionManager.open()` so authentication/startup failures remain durable and resumable; native IDs, filenames, format, and all subsequent writes remain Pi-managed.

**Scope**

- Register the action-discriminated `subagent` tool contract with caller-specific Definition constraints.
- Add the child-runtime adapter around Pi's in-process runtime/session APIs and proper runtime bind, start, stop, and disposal behavior.
- Load normal Pi resources for the child and inject the Definition with `appendSystemPromptOverride(base => [...base, body])`.
- Resolve model, authentication, and non-inherited thinking at invocation time.
- Activate exactly the Definition's tool names and revalidate availability before prompting.
- Create native child Sessions in the master-namespaced directory and open existing native JSONL Sessions for reuse.
- Persist direct ownership as a custom entry before exposing a newly created child.
- Resolve ownership against the parent's active branch and enforce the one-live-binding lock.
- Implement blocking `run`, direct `list-subagents`, and branch-visible `list-sessions` behavior for a direct child.
- Extract only the terminal assistant message's last nonempty text block and apply Pi-compatible parent-output truncation without changing the child JSONL.

**Implementation notes**

- Pass only `task` to `session.prompt()`; do not copy parent messages or build a context-fork mode.
- Keep the master namespace explicit in every Session-store operation even though the tool accepts a bare child UUID.
- Use `SessionManager.create(cwd, masterDirectory)` and its native ID/filename rather than generating durable IDs.
- A Session lock must be acquired before runtime startup and released in one `finally` path after full disposal, including startup errors and abort races.
- Definition changes affect the next runtime only. Do not rewrite prior Session entries or infer a Definition from history.
- The blocking path returns an error tool result with Session ID and reason on child failure; cancellation follows the caller's abort signal.
- Make output truncation a shared utility so list previews, blocking results, and later notifications cannot diverge from Pi's ceiling.

**Validation**

- `npm test -- test/blocking-run.test.ts test/sessions.test.ts test/prompt-resolution.test.ts` — proves exact task isolation, native persistence, branch ownership, Definition-independent reuse, lock release, model/thinking precedence, append-slot placement, exact tools, error results, and final-text extraction with fake Pi runtimes.
- `npm run typecheck` — proves the runtime and Session adapters use supported Pi 0.83.0 contracts.

**Dependencies**

- Slice 1.

### Slice 3 — Move Definition discovery into the prompt and tool action

**Status:** Complete

**Outcome**

Every main or child caller sees its own available Definitions at the top of the append-system section and can request the identical plain-text list explicitly, while the `subagent` tool description no longer carries catalog data.

**Completed work**

- Added the exact shared Definition-discovery formatter, caller-scoped `list-definitions` action, stable generic tool description, and retained caller-constrained `run.agent` schema.
- Added idempotent main prompt lifecycle injection at Pi's native append boundary and child resource ordering as discovery, existing append prompts, then active Definition body; child `subagent` tools receive a caller-scoped discovery override pending nested coordination.
- Validation: `npm test -- test/definition-discovery.test.ts test/prompt-resolution.test.ts test/package.test.ts` (11 tests passed); `npm run typecheck` (passed); full `npm test` (47 tests passed); `npm pack --dry-run` (passed, 7 package files); `PI_OFFLINE=1 pi -e . --help` (passed).
- Deviations: None.

**Scope**

- Add one pure formatter for caller-scoped Definition projections. Its nonempty and empty output must exactly match the strings in the specification.
- Add `{ action: "list-definitions" }` to the discriminated tool schema and dispatch it without requiring runtime or Session state.
- Replace the catalog-bearing dynamic tool description with a stable generic description that contains no Definition names or descriptions.
- Keep `run.agent` as the caller-constrained enum so runtime validation is not weakened.
- Inject the main agent's complete caller catalog at the very top of the native append-system section through Pi's prompt lifecycle.
- Inject a child's permitted catalog at the front of `appendSystemPromptOverride`, ahead of all existing append-system prompts; keep its active Definition body after those existing prompts.
- Use the same caller projection and formatter for prompt injection and `list-definitions`, including callers with no available Definitions.

**Implementation notes**

- The main caller receives all loaded Definitions. A child receives only the Definitions in its creator Definition's `subagent_agents`; an empty allowlist uses the exact empty-catalog text.
- Use `before_agent_start` and its structured system-prompt options for the TUI-connected main runtime, preserving custom/default base prompt content, existing append content, project context, skills, and current-working-directory sections. Do not append discovery to the end of the fully assembled prompt.
- In controlled child resource loading, the append array order is `[discovery, ...existing, definitionBody]`.
- Make host prompt injection idempotent and compatible with other extensions modifying the same lifecycle event; one agent start must contain exactly one cooperate discovery block.
- Do not expose descriptions through the generic tool description. The `run.agent` schema still exposes only allowed names as enum values by design.
- Preserve caller-catalog order rather than independently sorting prompt and action output.

**Validation**

- `npm test -- test/definition-discovery.test.ts test/prompt-resolution.test.ts test/package.test.ts` — proves exact nonempty/empty text, the new action shape and dispatch, description redaction, caller scoping, main prompt placement, child append order, preservation of existing prompt sections, and no duplicate injection.
- `npm run typecheck` — proves prompt lifecycle and resource-loader integration use supported Pi 0.83.0 contracts.

**Dependencies**

- Slice 2.

### Slice 4 — Coordinate a nested structured runtime tree

**Status:** Complete

**Outcome**

Any permitted child can create its own direct children up to `maxDepth`; active bindings form an observable structured tree in which failures are sibling-isolated, cancellation cascades downward, and every parent scope remains alive until its descendants stop.

**Completed work**

- Added a shared structured coordinator with collision-checked transient IDs, master-wide Session locks, depth enforcement, running/waiting state, immutable retained subtree snapshots, downward cancellation scopes, first-cause terminal transitions, and idempotent full-scope waiting.
- Replaced the child discovery-only tool with caller-scoped nested coordination, persisted nested ownership in the parent child Session, enforced direct Definition permissions and pre-creation depth limits, and retained exact child tool activation.
- Added awaited child and root `agent_end` scope hooks so parent lifecycle completion waits for descendant disposal, with failed-node descendant cancellation and structural sibling isolation.
- Validation: `npm test -- test/coordinator.test.ts test/nested-run.test.ts test/structured-cancellation.test.ts` (9 tests passed); `npm run typecheck` (passed); full `npm test` (57 tests passed).
- Deviations: None.

**Scope**

- Add the in-memory coordinator for root/parent relationships, collision-checked 8-hex-character IDs, Session locks, depth, state, elapsed time, and subtree snapshots.
- Instantiate the scoped `subagent` tool inside child runtimes when it is present in the Definition's exact tool allowlist.
- Restrict nested `run` to the creator Definition's `subagent_agents` and reject over-depth runs before Session creation or locking.
- Track `running` versus `waiting` from the parent's own loop and descendant count.
- Hold each runtime's `agent_end` lifecycle until its descendant scope has terminated.
- Cascade a failed node's cancellation through its descendants while allowing siblings to continue.
- Cascade root/tool abort through the applicable subtree and await complete, idempotent disposal.
- Produce immutable subtree update details suitable for later blocking tool rendering without adding UI in this slice.

**Implementation notes**

- Model ownership between Sessions, not between transient runtime objects. The coordinator may cache resolved direct edges but the persisted custom entry remains authoritative after reload.
- Separate a node's own-loop terminal signal from its scope terminal signal; `waiting` spans the interval between them.
- Use per-node cancellation scopes linked downward, not one global abort controller, so sibling isolation is structural.
- Record only the first terminal cause for a node and make repeated fail/cancel/dispose operations no-ops after the winning transition.
- Suppress descendant cancellation reports at the coordinator boundary; only the failed or explicitly targeted direct child is parent-observable.
- Do not add permits, queues, result caches, retries, or persistent runtime IDs.

**Validation**

- `npm test -- test/coordinator.test.ts test/nested-run.test.ts test/structured-cancellation.test.ts` — proves permission and depth rejection, ID/lock invariants, running-to-waiting transitions, descendant waiting, sibling failure isolation, vertical cancellation, and idempotent race handling under deterministic deferred promises.
- `npm run typecheck` — proves child runtimes can receive the scoped tool without broadening configured tools.

**Dependencies**

- Slice 3.

### Slice 5 — Run asynchronously and manage direct children

**Status:** Complete

**Outcome**

An agent can start direct children asynchronously, continue its own work, list/wait for/cancel those children, and automatically resume when each terminal notification arrives while Pi's native Working state covers the complete descendant tree.

**Completed work**

- Added prompt-independent asynchronous startup with transient and Session identity acknowledgement, exact direct-child capture for wait/cancel, and shared blocking/async terminal cleanup over the structured coordinator.
- Added persisted exactly-once completion messages with tool-result commit gating, steer/follow-up routing from the parent's logical phase, independent completion delivery, explicit-cancel reporting, and lifecycle/cascade cancellation suppression.
- Bound continuation adapters in the main and every child Pi runtime, retained aggregate `agent_end` waiting, and completed management action dispatch/results without broadening caller visibility.
- Validation: `npm test -- test/async-run.test.ts test/management-actions.test.ts test/continuation.test.ts test/working-lifecycle.test.ts` (8 tests passed); `npm run typecheck` (passed); full `npm test` (65 tests passed); `npm pack --dry-run` (passed, 9 package files); `PI_OFFLINE=1 pi -e . --help` (passed).
- Deviations: None.

**Scope**

- Implement async `run` startup acknowledgement with `subagentId` and Session ID.
- Add exactly-once terminal custom messages for asynchronous success, failure, and explicit cancellation.
- Route completion as `steer` before the parent's logical loop end and `followUp` while its aggregate `agent_end` is waiting.
- Gate very fast completions until the starting async tool result has been committed.
- Complete direct-active `list-subagents`, persistent `list-sessions`, wait-all `wait`, and subtree `cancel` validation and results.
- Keep each completion independent while allowing Pi's existing message queue to order simultaneous completions.
- Suppress notifications for lifecycle-wide cancellation and cascade-cancelled descendants.
- Include nested usage in tool results when the Pi API supports it, without changing completion content semantics.

**Implementation notes**

- Track the parent's logical phase explicitly; `ctx.isIdle()` alone cannot distinguish an aggregate handler waiting inside `agent_end`.
- `wait` captures valid handles atomically, then waits for every terminal state. It succeeds even if captured children fail or are cancelled because their custom messages carry those outcomes.
- Never cache a completed runtime result for later `wait`; once the active binding is gone, its ID is invalid.
- A blocking invocation must remain message-free even though it uses the same coordinator terminal path.
- Build model-visible notification content separately from renderer-only details. Exclude terminal `subagentId` from both durable model content and any interface that implies resumability.
- Preserve one notification for the explicit cancel target after its subtree is stopped; never emit one per descendant.

**Validation**

- `npm test -- test/async-run.test.ts test/management-actions.test.ts test/continuation.test.ts` — proves prompt return timing, fast-completion gating, exactly-once messages, steer/follow-up selection, uncoalesced completions, direct-child validation, wait-all semantics, explicit cancel reporting, and lifecycle-cancellation suppression.
- `npm test -- test/working-lifecycle.test.ts` — proves the root `agent_end` remains pending through asynchronous descendant work and resolves only after the full tree settles.
- `npm run typecheck` — proves custom-message and lifecycle event usage remains compatible with Pi 0.83.0.

**Dependencies**

- Slice 4.

### Slice 6 — Preserve Session semantics across Pi lifecycle changes

**Status:** Complete

**Outcome**

Child ownership and data remain correct through compaction, branch navigation, master resume, `/fork`, and `/clone`; replacement and shutdown cancel live work safely; startup can remove only genuinely orphaned master directories.

**Completed work**

- Kept ownership derived live from native branch custom entries, verified compaction and branch switching, and made tree navigation and interrupted main turns cancel and await the complete active runtime while preserving reuse after navigation.
- Added fork/clone startup handling that resolves the previous master through Pi Session metadata, flushes the old runtime, copies the complete child namespace through a sibling stage, rejects collisions, atomically publishes the copy, and reopens copied children at fresh absolute paths without changing IDs or bytes.
- Added post-copy orphan selection against native master Session headers, configured trash-first deletion with recursive fallback, and verified fresh runtimes treat crash-left child JSONL as unlocked resumable data.
- Validation: `npm test -- test/branch-visibility.test.ts test/session-lifecycle.test.ts` (5 tests passed); `npm test -- test/master-fork.test.ts test/orphan-gc.test.ts` (6 tests passed); `npm run typecheck` (passed); full `npm test` (76 tests passed).
- Deviations: None.

**Scope**

- Reconstruct visible ownership from custom entries on the current `SessionManager.getBranch()` path.
- Refresh branch-derived visibility after tree navigation and verify compaction leaves ownership discoverable.
- On tree navigation, new/resume switch, reload, fork/clone, and exit, stop and await the complete active tree before old runtime teardown completes.
- On `session_start` with `reason: "fork"`, resolve old and new master IDs and clone the complete old child directory into the new namespace.
- Stage clone data in a temporary sibling, atomically rename it, reject destination collisions, and clean failed staging without touching the source.
- Ensure copied nested ownership resolves through unchanged child UUIDs and copied branch paths.
- Detect orphan master directories against Pi's existing master Sessions after required fork copying.
- Implement configured cleanup through `trash` when available with recursive-removal fallback.
- Treat crash-left child JSONL as unlocked, resumable data without synthesizing runtime state or notifications.

**Implementation notes**

- Parse the previous master ID from `previousSessionFile` through Pi Session metadata rather than filename assumptions.
- Complete old runtime disposal before starting the copy so all JSONL writes are flushed.
- Never merge into a pre-existing new-master directory. Surface initialization failure instead of guessing which files win.
- Copy the whole flat directory; branch filtering happens through ownership entries and does not require selecting files during clone.
- Run orphan selection only after fork/clone handling. Make selection and deletion separate, testable operations.
- Resolve fresh absolute paths for `list-sessions`; do not rewrite historical tool results containing old paths.
- Cleanup handlers must remain safe when Pi emits shutdown after an earlier abort or when a replacement operation fails.

**Validation**

- `npm test -- test/branch-visibility.test.ts test/session-lifecycle.test.ts` — proves custom-entry path membership, compaction survival, resume reconstruction, replacement cancellation, crash recovery semantics, and fresh path resolution.
- `npm test -- test/master-fork.test.ts test/orphan-gc.test.ts` — proves byte-equivalent independent copies with unchanged child IDs, nested references, hidden-file behavior, atomic failure cleanup, destination collision rejection, GC ordering, orphan selection, trash use, and fallback removal in temporary directories.
- `npm run typecheck` — proves all Session lifecycle handlers use supported event fields.

**Dependencies**

- Slice 5.

### Slice 7 — Deliver the complete TUI presentation

**Status:** Complete

**Outcome**

Blocking runs, async starts, management actions, terminal messages, and the active runtime tree have the approved compact visual hierarchy, expanded detail, live updates, and keyboard-driven cancellation flow.

**Completed work**

- Added exact action-specific tool headers and compact/expanded result rendering, live blocking-subtree updates, retained terminal snapshots, semantic state marks, responsive hierarchy rendering, and resolved model/thinking presentation metadata.
- Added the standard-expanded-state custom completion renderer and a live bordered `/subagents` overlay with active-tree scrolling, list/detail/empty views, accent selection, default-No subtree cancellation confirmation, awaited cancellation, and TUI-only command handling.
- Post-completion correction: replaced the initial centered, manually drawn overlay with the local `model-presets` interaction and visual structure: non-positioned `ctx.ui.custom`, `Container`, accent `DynamicBorder`, titled `Text`, native `SelectList`, and dim footer; details and cancellation remain in the same shell.
- UI presentation and interaction are reserved for manual inspection; the temporary renderer and overlay test files were removed at user request.
- Validation: `npm run typecheck` (passed); full `npm test` (77 tests passed); `npm pack --dry-run` (passed, 12 package files); `PI_OFFLINE=1 pi -e . --help` (passed). Escape now closes explicitly from the list, including the empty state, rather than relying on `SelectList` input forwarding.
- Deviations: Planned automated TUI renderer and overlay tests were removed by explicit user direction; visual and interactive correctness requires manual verification.

**Scope**

- Add action-specific `renderCall` and `renderResult` implementations with the exact headers, including `subagent list-definitions`, title/accent/muted roles, collapsed summaries, and expanded content.
- Feed blocking `run` subtree snapshots through `onUpdate`, including nested hierarchy, state marks, elapsed time, task previews, and retained terminal state.
- Register the `[subagent]` custom-message renderer with Pi's standard expanded state and the exact collapsed terminal strings.
- Implement `/subagents` as a bordered overlay based on the `model-preset` interaction pattern.
- Add list, detail, empty, and cancellation-confirmation views with responsive widths, scrolling, Enter/Escape/c controls, default-No confirmation, and live rerender invalidation.
- Keep UI components read-only over coordinator snapshots except for the explicit cancel command.
- Handle unavailable UI contexts without affecting tool/runtime behavior.

**Implementation notes**

- Use Pi theme roles and accent directly; do not import, inspect, or monkeypatch `ui-shell`.
- Reuse Pi TUI components such as `Container`, `Text`, `SelectList`, and `DynamicBorder` where they preserve the approved visual result.
- Calculate task previews from available component width and ensure every component obeys its render width.
- Keep elapsed formatting and state-to-mark/color mapping in shared presentation helpers so tool rows, messages, and overlay do not drift.
- The blocking renderer's snapshot is only the invocation subtree. The overlay snapshot is the entire active tree excluding the main root.
- Confirmation must await coordinator cancellation before returning to the refreshed list; a concurrent terminal transition should make the operation harmless.
- Test rendered lines and interaction state deterministically rather than requiring a human-operated Pi TUI.

**Validation**

- `npm test -- test/tool-renderer.test.ts test/message-renderer.test.ts` — proves exact headers/text, collapsed and expanded data, state marks, hierarchy, terminal retention, colors by semantic role, and narrow/wide truncation.
- `npm test -- test/subagents-overlay.test.ts` — proves full-tree rows, empty state, navigation, details, responsive rendering, confirmation default, cancellation awaiting, race tolerance, and live invalidation with a fake TUI.
- `npm run typecheck` — proves renderer and TUI components conform to Pi 0.83.0 APIs.

**Dependencies**

- Slice 5. It may proceed in parallel with Slice 6 once coordinator and async message contracts are stable.

## Final verification

- `npm run typecheck` — verifies the complete extension and tests compile against the targeted Pi API.
- `npm test` — runs the full deterministic suite for catalog, runtime, Session persistence, structured concurrency, lifecycle, tool behavior, and TUI presentation without network or model credentials.
- `npm pack --dry-run` — verifies the private package contains its declared extension entry and required source files without publishing it.
- `PI_OFFLINE=1 pi -e . --help` — loads the package through the installed Pi package/extension loader without a provider request; this proves startup integration but not a real model invocation or interactive rendering.

