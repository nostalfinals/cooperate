import { truncateHead, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionTitle } from "./result.ts";

export const COMPLETION_MESSAGE = "subagent";
export const REMINDER_MESSAGE = "subagent-reminder";

export interface CompletionNotice {
  agent: string;
  state: "finished" | "failed" | "cancelled";
  subagentId: string;
  sessionId: string;
  task?: string;
  result?: string;
  reason?: string;
  elapsedMs: number;
}

/** Periodic nudge about still-running subagents; shown to the caller model but not rendered to the user. */
export interface ReminderNotice {
  text: string;
  elapsedMs?: number;
  /** The direct children currently due for a nudge. */
  subagentIds?: readonly string[];
}

export interface Messenger {
  waitForStartupCommit(toolCallId: string): Promise<void>;
  send(notice: CompletionNotice): Promise<void>;
  sendReminder(reminder: ReminderNotice): Promise<void>;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function bounded(value: string): string {
  const head = truncateHead(value);
  return !head.truncated || head.content.length > 0 ? head.content : truncateTail(value).content;
}

function completionContent(notice: CompletionNotice): string {
  const title = completionTitle(notice.agent, notice.state, notice.subagentId, notice.sessionId);
  const content = notice.state === "finished"
    ? `${title}\n\n${notice.result ?? "<none>"}`
    : `${title}\n\n${notice.reason ?? notice.state}`;
  return bounded(content);
}

function reminderContent(reminder: ReminderNotice): string {
  return bounded(reminder.text);
}

/**
 * Decide how a message enters the caller's agent loop.
 *
 * An idle loop never drains its steering queue, so messages for an idle agent
 * must be delivered as follow-ups, which append them and start a new turn
 * instead of parking them in the steer queue forever.
 */
function selectDelivery(isIdle: boolean, ending: boolean): "steer" | "followUp" {
  if (isIdle || ending) return "followUp";
  return "steer";
}

export function createCompletionMessenger(pi: ExtensionAPI): Messenger {
  let busy = false;
  let ending = false;
  let queuedBatch: { notices: CompletionNotice[]; content: { type: "text"; text: string } } | undefined;
  let lastCtx: Pick<ExtensionContext, "isIdle"> | undefined;
  const commits = new Map<string, Deferred>();

  const isIdle = (): boolean => (lastCtx ? lastCtx.isIdle() : !busy);
  const deliver = (notice: CompletionNotice, deliverAs: "steer" | "followUp") => {
    pi.sendMessage({
      customType: COMPLETION_MESSAGE,
      content: completionContent(notice),
      display: true,
      details: notice,
    }, {
      deliverAs,
      triggerTurn: true,
    });
  };
  const queueBusy = (notice: CompletionNotice) => {
    const deliverAs = selectDelivery(isIdle(), ending);
    if (queuedBatch) {
      queuedBatch.notices.push(notice);
      queuedBatch.content.text = bounded(`${queuedBatch.content.text}\n\n${completionContent(notice)}`);
      return;
    }
    const batch = {
      notices: [notice],
      content: { type: "text" as const, text: completionContent(notice) },
    };
    queuedBatch = batch;
    pi.sendMessage({
      customType: COMPLETION_MESSAGE,
      content: [batch.content],
      display: true,
      details: batch.notices,
    }, {
      deliverAs,
      triggerTurn: true,
    });
  };

  const captureCtx = (ctx: Pick<ExtensionContext, "isIdle"> | undefined) => {
    if (ctx) lastCtx = ctx;
  };
  pi.on("agent_start", (_event, ctx) => {
    captureCtx(ctx);
    busy = true;
    ending = false;
  });
  pi.on("agent_end", (_event, ctx) => {
    captureCtx(ctx);
    ending = true;
  });
  pi.on("agent_settled", (_event, ctx) => {
    captureCtx(ctx);
    busy = false;
    ending = false;
  });
  pi.on("message_start", (event, ctx) => {
    captureCtx(ctx);
    const message = event.message as { role?: string; customType?: string; details?: unknown };
    if (message.role === "custom" && message.customType === COMPLETION_MESSAGE
      && message.details === queuedBatch?.notices) {
      queuedBatch = undefined;
    }
  });
  pi.on("message_end", (event, ctx) => {
    captureCtx(ctx);
    const message = event.message as { role?: string; toolName?: string; toolCallId?: string };
    if (message.role !== "toolResult" || message.toolName !== "subagent" || typeof message.toolCallId !== "string") return;
    const pending = commits.get(message.toolCallId);
    if (!pending) return;
    commits.delete(message.toolCallId);
    pending.resolve();
  });

  return {
    waitForStartupCommit(toolCallId) {
      let pending = commits.get(toolCallId);
      if (!pending) {
        pending = deferred();
        commits.set(toolCallId, pending);
      }
      return pending.promise;
    },
    async send(notice) {
      if (isIdle()) {
        deliver(notice, "followUp");
        return;
      }
      queueBusy(notice);
    },
    async sendReminder(reminder) {
      pi.sendMessage({
        customType: REMINDER_MESSAGE,
        content: reminderContent(reminder),
        display: false,
        details: reminder,
      }, {
        deliverAs: selectDelivery(isIdle(), ending),
        triggerTurn: true,
      });
    },
  };
}

export class DeferredMessenger implements Messenger {
  private messenger?: Messenger;
  private readonly ready = deferred();

  bind(messenger: Messenger): void {
    if (this.messenger) return;
    this.messenger = messenger;
    this.ready.resolve();
  }

  async waitForStartupCommit(toolCallId: string): Promise<void> {
    await this.ready.promise;
    await this.messenger!.waitForStartupCommit(toolCallId);
  }

  async send(notice: CompletionNotice): Promise<void> {
    await this.ready.promise;
    await this.messenger!.send(notice);
  }

  async sendReminder(reminder: ReminderNotice): Promise<void> {
    await this.ready.promise;
    await this.messenger!.sendReminder(reminder);
  }
}
