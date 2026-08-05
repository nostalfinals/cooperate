import { truncateHead, truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COMPLETION_MESSAGE = "subagent";

export interface CompletionNotice {
  agent: string;
  state: "finished" | "failed" | "cancelled";
  sessionId: string;
  result?: string;
  reason?: string;
  elapsedMs: number;
}

export interface Messenger {
  waitForStartupCommit(toolCallId: string): Promise<void>;
  send(notice: CompletionNotice): Promise<void>;
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
  const title = `Subagent ${notice.agent} ${notice.state}.\nSession: ${notice.sessionId}`;
  const content = notice.state === "finished"
    ? `${title}\n\n${notice.result ?? "<none>"}`
    : `${title}\n\n${notice.reason ?? notice.state}`;
  return bounded(content);
}

export function createCompletionMessenger(pi: ExtensionAPI): Messenger {
  let ending = false;
  const commits = new Map<string, Deferred>();

  pi.on("agent_start", () => { ending = false; });
  // Registered before the structured-scope agent_end handler, this marks the
  // logical loop end even while that later handler remains pending on children.
  pi.on("agent_end", () => { ending = true; });
  pi.on("message_end", (event) => {
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
      pi.sendMessage({
        customType: COMPLETION_MESSAGE,
        content: completionContent(notice),
        display: true,
        details: { ...notice },
      }, {
        deliverAs: ending ? "followUp" : "steer",
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
}
