# Specification: Source modularization

## Status
Approved for implementation.

## Context

`cooperate` is a working private Pi extension whose behavior is covered by 77 deterministic tests. Its approximately 2,300 lines of production TypeScript are currently concentrated in a small set of flat modules. In particular, `src/subagent.ts` combines application orchestration, runtime contracts, result extraction, TypeBox schemas, Pi tool dispatch, and TUI rendering, while `src/catalog.ts` combines filesystem loading, parsing, validation, caller projection, and tool-schema construction.

The concentration makes unrelated changes touch the same files, obscures dependency direction, and forces core orchestration to depend on Pi presentation concerns. This change reorganizes the source around explicit responsibilities without changing the extension behavior approved in `../subagent-extension/SPEC.md`.

## Goals and non-goals

### Goals

- Separate subagent orchestration from the Pi tool and TUI adapters.
- Separate catalog configuration loading, Definition parsing, cross-catalog validation, and caller projection.
- Make child runtime and Session persistence implementations conform to contracts that do not depend on those implementations.
- Separate Session ownership, native storage, master namespace copying, orphan cleanup, and shared output-text handling.
- Reduce the package entry point to composition and default export concerns.
- Preserve all existing observable behavior and deterministic verification.

### Non-goals

- Changing the `subagent` tool schema, output, rendering, or action semantics.
- Changing synchronous, asynchronous, nested, cancellation, continuation, or structured-scope behavior.
- Changing Definition/configuration formats, prompt construction, native Session JSONL, ownership entries, storage paths, fork/clone behavior, or orphan collection.
- Redesigning `StructuredCoordinator` merely to reduce its line count.
- Splitting the `SubagentsOverlay` state machine without automated UI coverage.
- Introducing a general-purpose framework, barrel modules throughout the tree, new dependencies, or a broad test-suite reorganization.
- Preserving compatibility for old private source import paths.

## Required behavior

### Behavioral preservation

The refactored package must retain the behavior defined by `../subagent-extension/SPEC.md`. In particular:

- The complete action-discriminated `subagent` tool contract and caller-constrained `run.agent` schema remain unchanged.
- Blocking, asynchronous, resumed, and nested runs retain their current startup, result, notification, waiting, failure, and cancellation semantics.
- Depth enforcement, transient IDs, Session locks, subtree snapshots, sibling isolation, and structured lifecycle waiting remain unchanged.
- Definition discovery, prompt placement, model/thinking resolution, and exact tool activation remain unchanged.
- Native Session creation, direct ownership, branch visibility, inspection, master fork/clone copying, and orphan cleanup remain unchanged.
- Tool renderers, completion rendering, and `/subagents` behavior remain unchanged.
- Existing error messages and validation ordering are preserved unless an import-path-only test update is required.

### Source boundaries

The destination source layout is:

```text
src/
├── index.ts
├── extension.ts
├── continuation.ts
├── prompt.ts
├── text.ts
├── catalog/
│   ├── types.ts
│   ├── config.ts
│   ├── definitions.ts
│   ├── catalog.ts
│   └── caller-catalog.ts
├── subagent/
│   ├── types.ts
│   ├── ports.ts
│   ├── result.ts
│   ├── coordinator.ts
│   └── service.ts
├── tool/
│   ├── schema.ts
│   ├── subagent-tool.ts
│   └── renderer.ts
├── runtime/
│   ├── invocation-settings.ts
│   └── pi-child-runtime.ts
├── sessions/
│   ├── ownership.ts
│   ├── native-store.ts
│   ├── master-copy.ts
│   └── orphan-gc.ts
└── ui/
    ├── presentation.ts
    └── subagents-overlay.ts
```

Small private helpers may remain in the file that owns their behavior. Additional files are allowed only when they preserve these responsibility boundaries rather than introducing generic abstraction layers.

### Dependency rules

- `subagent/service.ts` owns run orchestration and direct-child management. It must not import TypeBox, Pi TUI components, tool renderers, or UI presentation modules.
- `subagent/types.ts`, `subagent/ports.ts`, and `subagent/result.ts` must remain independent of concrete Pi runtime, filesystem Session store, and TUI implementations.
- `subagent/coordinator.ts` remains the cohesive implementation of the runtime tree, locking, state, and cancellation model. Shared snapshot and terminal types are exposed from `subagent/types.ts` so consumers do not depend on the coordinator implementation for types.
- `tool/` owns the TypeBox action schema, Pi `ToolDefinition` adapter, action dispatch, tool-result construction, and tool rendering.
- Catalog modules own configuration and Definition data. Caller projection returns allowed Definitions and discovery text but does not construct TypeBox or Pi tool schemas.
- `runtime/pi-child-runtime.ts` implements the child-runtime port. Invocation model/thinking policy is isolated in `runtime/invocation-settings.ts`. The adapter must not depend on the concrete subagent service implementation.
- `sessions/native-store.ts` implements the Session-store port. Ownership, master copy, and orphan cleanup remain separately testable operations.
- `ui/` depends on immutable snapshots and UI-facing data, not on the coordinator implementation or Session-store implementation.
- `extension.ts` is the composition root for Pi event handlers and concrete adapters. `index.ts` remains a minimal package entry that exposes the factory and default extension.
- Cross-module imports must follow these directions without creating runtime import cycles.

### Naming and migration

- `BlockingSubagentService` becomes `SubagentService`, and its associated options type follows the same naming.
- All production and test imports move to the new owning modules in the same slice as the moved symbol.
- The old monolithic source files are removed after their symbols have moved. Compatibility re-export shims are not retained.
- Existing `docs/agent-tasks/subagent-extension/` artifacts remain unchanged.

## Design decisions

- Organize by capability with explicit adapter boundaries rather than applying a full layered or clean-architecture framework.
- Split modules by responsibility and reason to change, not by a hard maximum line count.
- Keep cohesive stateful units intact: `StructuredCoordinator` remains one implementation and `SubagentsOverlay` remains one component.
- Keep `continuation.ts` and `prompt.ts` as focused top-level modules; directory symmetry alone is not a reason to split them.
- Use direct imports from owning files rather than introducing barrel `index.ts` files throughout the source tree.
- Treat source paths as private implementation details, allowing direct import updates without compatibility wrappers.
- Perform structural moves without opportunistic logic cleanup so regressions can be attributed to a single slice.

## Constraints

- The project remains an ESM TypeScript Pi package targeting the existing Pi 0.83.0 APIs.
- Import specifiers retain the repository's explicit `.ts` convention.
- No runtime or development dependency is added for the refactor.
- Production behavior must remain compatible with all existing deterministic tests and offline package loading; no model credentials, network service, interactive terminal, or manual verification may be required.
- Existing working-tree changes, if present when implementation begins, must be preserved.

## Acceptance criteria

- `src/subagent.ts` no longer combines service, schema, tool, and renderer responsibilities; `SubagentService` has no TypeBox or Pi TUI dependency.
- Catalog loading, Definition parsing, validation, caller projection, and tool-schema construction reside in their designated modules, and catalog code no longer constructs a TypeBox schema.
- Child runtime and Session store implementations satisfy implementation-independent ports defined outside their adapter modules.
- Session ownership, native storage, master copy, orphan cleanup, and output-text helpers are independently located and retain existing behavior.
- Snapshot consumers can import snapshot types without importing the coordinator implementation.
- `index.ts` is a minimal entry point and `extension.ts` is the composition root.
- Old monolithic module paths and temporary compatibility shims are absent after migration.
- No new dependencies or source import cycles are introduced.
- All 77 existing behavioral tests, TypeScript type checking, package dry run, and offline Pi package-load smoke check pass.
