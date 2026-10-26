import type { CloseReason, TerminalBridge } from './terminal-bridge.js';

interface Entry {
  readonly sessionId: string;
  readonly userId: string;
  readonly targetId: string;
  readonly bridge: TerminalBridge;
}

/** Live sessions on this broker replica (Phase 08 §8.4): close one, all of a user's, or everything on shutdown. */
export class SessionRegistry {
  private readonly sessions = new Map<string, Entry>();

  add(entry: Entry): void {
    this.sessions.set(entry.sessionId, entry);
    entry.bridge.onClosed(() => this.sessions.delete(entry.sessionId));
  }

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  countForUser(userId: string): number {
    let n = 0;
    for (const e of this.sessions.values()) if (e.userId === userId) n++;
    return n;
  }

  close(sessionId: string, reason: CloseReason): boolean {
    const entry = this.sessions.get(sessionId);
    entry?.bridge.close(reason);
    return entry !== undefined;
  }

  closeUser(userId: string, reason: CloseReason): number {
    return this.closeWhere((e) => e.userId === userId, reason);
  }

  closeAll(reason: CloseReason): number {
    return this.closeWhere(() => true, reason);
  }

  private closeWhere(predicate: (e: Entry) => boolean, reason: CloseReason): number {
    const matching = [...this.sessions.values()].filter(predicate);
    for (const e of matching) e.bridge.close(reason);
    return matching.length;
  }
}
