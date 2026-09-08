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
  return isIdle || ending ? "followUp" : "steer";
}

const IDLE_BATCH_DELAY_MS = 250;

export function createCompletionMessenger(pi: ExtensionAPI): Messenger {
  let busy = false;
  let ending = false;
  let idleBatchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtx: Pick<ExtensionContext, "isIdle"> | undefined;
  const pendingNotices: CompletionNotice[] = [];
  const commits = new Map<string, Deferred>();

  const isIdle = (): boolean => (lastCtx ? lastCtx.isIdle() : !busy);
  const clearIdleBatchTimer = () => {
    if (idleBatchTimer === undefined) return;
    clearTimeout(idleBatchTimer);
    idleBatchTimer = undefined;
  };
  const flush = () => {
    clearIdleBatchTimer();
    // A steering message delivered after the loop's final queue poll is never
    // consumed. Keep notices until agent_end, where Pi explicitly supports a
    // follow-up continuation from an extension handler.
    if (pendingNotices.length === 0 || (!isIdle() && !ending)) return;
    const notices = pendingNotices.splice(0);
    pi.sendMessage({
      customType: COMPLETION_MESSAGE,
      content: [{ type: "text", text: bounded(notices.map(completionContent).join("\n\n")) }],
      display: true,
      details: notices,
    }, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
  };
  const scheduleIdleFlush = () => {
    if (idleBatchTimer !== undefined || pendingNotices.length === 0) return;
    idleBatchTimer = setTimeout(flush, IDLE_BATCH_DELAY_MS);
  };
  const captureCtx = (ctx: Pick<ExtensionContext, "isIdle"> | undefined) => {
    if (ctx) lastCtx = ctx;
  };
  pi.on("agent_start", (_event, ctx) => {
    captureCtx(ctx);
    clearIdleBatchTimer();
    busy = true;
    ending = false;
  });
  pi.on("agent_end", (_event, ctx) => {
    captureCtx(ctx);
    ending = true;
    flush();
  });
  pi.on("agent_settled", (_event, ctx) => {
    captureCtx(ctx);
    busy = false;
    ending = false;
    scheduleIdleFlush();
  });
  pi.on("message_start", (_event, ctx) => {
    captureCtx(ctx);
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
      pendingNotices.push(notice);
      if (ending) {
        flush();
      } else if (isIdle()) {
        scheduleIdleFlush();
      }
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
