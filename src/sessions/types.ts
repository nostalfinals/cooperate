export interface SessionRecord {
  sessionId: string;
  file: string;
  native?: unknown;
}

export interface SessionInspection {
  task: string;
  result: string;
}

export interface SessionStore {
  create(): Promise<SessionRecord>;
  open(sessionId: string): Promise<SessionRecord>;
  list(): Promise<readonly SessionRecord[]>;
  inspect(record: SessionRecord): Promise<SessionInspection>;
}
