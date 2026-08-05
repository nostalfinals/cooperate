import { Type, type TSchema } from "typebox";

export function actionSchema(agentSchema: TSchema): TSchema {
  return Type.Union([
    Type.Object({
      action: Type.Literal("run"),
      agent: agentSchema,
      task: Type.String({ minLength: 1 }),
      sessionId: Type.Optional(Type.String()),
      async: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("list-definitions") }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("list-subagents") }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("list-sessions") }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal("wait"),
      subagentIds: Type.Array(Type.String({ pattern: "^[0-9a-f]{8}$" }), { minItems: 1, uniqueItems: true }),
    }, { additionalProperties: false }),
    Type.Object({
      action: Type.Literal("cancel"),
      subagentId: Type.String({ pattern: "^[0-9a-f]{8}$" }),
    }, { additionalProperties: false }),
  ], { type: "object" });
}
