import { Type, type TSchema } from "typebox";

const ACTIONS = ["run", "list-definitions", "list-subagents", "list-sessions", "wait", "cancel"] as const;

export function actionSchema(): TSchema {
  return Type.Object({
    action: Type.String({ enum: ACTIONS, description: "run starts a subagent; list-* queries definitions or active subagents/sessions; wait blocks until the given subagents finish; cancel aborts a subagent" }),
    agent: Type.Optional(Type.String({ minLength: 1, description: "run: definition name available to this caller" })),
    task: Type.Optional(Type.String({ minLength: 1, description: "run: short human-readable goal sentence shown to the user" })),
    prompt: Type.Optional(Type.String({ minLength: 1, description: "run: full prompt sent to the subagent" })),
    sessionId: Type.Optional(Type.String({ description: "run: existing session id to continue instead of starting a new one" })),
    async: Type.Optional(Type.Boolean({ description: "run: run in the background and return immediately instead of blocking; you will be notified when it finishes (default false)" })),
    subagentIds: Type.Optional(Type.Array(Type.String({ pattern: "^[0-9a-f]{8}$" }), { minItems: 1, uniqueItems: true, description: "wait: subagent ids to wait for, 8 hex characters each" })),
    subagentId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{8}$", description: "cancel: subagent id to cancel, 8 hex characters" })),
  }, { additionalProperties: false });
}
