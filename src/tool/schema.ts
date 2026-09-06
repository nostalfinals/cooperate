import { Type, type TSchema } from "typebox";

const ACTIONS = ["run", "list-definitions", "list-subagents", "list-sessions", "inspect", "history", "steer", "cancel"] as const;

export function actionSchema(): TSchema {
  return Type.Object({
    action: Type.String({ enum: ACTIONS, description: "run starts a subagent in the background; list-* queries definitions or active subagents/sessions; inspect shows a subagent's current state; history pages through its transcript; steer sends it a message; cancel aborts it" }),
    agent: Type.Optional(Type.String({ minLength: 1, description: "run: definition name available to this caller" })),
    task: Type.Optional(Type.String({ minLength: 1, description: "run: short human-readable goal sentence shown to the user" })),
    prompt: Type.Optional(Type.String({ minLength: 1, description: "run: full prompt sent to the subagent" })),
    sessionId: Type.Optional(Type.String({ description: "run: existing session id to continue instead of starting a new one" })),
    all: Type.Optional(Type.Boolean({ description: "list-subagents: also include completed direct subagents (default false)" })),
    subagentId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{8}$", description: "inspect/history/steer/cancel: subagent id, 8 hex characters" })),
    text: Type.Optional(Type.String({ minLength: 1, description: "steer: message text delivered to the subagent" })),
    messageId: Type.Optional(Type.String({ description: "history: return the full content of this message id instead of a page of summaries" })),
    offset: Type.Optional(Type.Number({ minimum: 0, description: "history: number of messages to skip (default 0)" })),
    limit: Type.Optional(Type.Number({ minimum: 1, description: "history: page size (default 50)" })),
  }, { additionalProperties: false });
}
