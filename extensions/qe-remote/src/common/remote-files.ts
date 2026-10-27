import type { FsOp } from '@qe/contracts';

import { RemoteApiError, type SessionSummary } from './remote-client';

/** `qe-ssh://<targetId>/<path relative to the target's remoteRoot>` (PHASE_09 §9.4). */
export const QE_SSH_SCHEME = 'qe-ssh';

/** The URI of a target's remote folder (its remoteRoot). */
export const remoteRootUri = (targetId: string): string => `${QE_SSH_SCHEME}://${targetId}/`;

/** The API path of a URI path: relative to remoteRoot, no leading slash (`/` → `''`). */
export const relativePath = (uriPath: string): string => uriPath.replace(/^\/+/, '');

export interface FilesApi {
  openFilesSession(targetId: string): Promise<{ sessionId: string }>;
  fileOp(sessionId: string, op: FsOp, body: object): Promise<unknown>;
  listSessions(): Promise<SessionSummary[]>;
}

/** Where a tab remembers its files-session per target across reloads (the browser's sessionStorage). */
export interface SessionStore {
  get(targetId: string): string | undefined;
  set(targetId: string, sessionId: string): void;
  delete(targetId: string): void;
}

const LIVE = new Set(['AUTHORIZED', 'CONNECTING', 'ACTIVE']);

/**
 * The files-session of each target, opened on first use. A session the server has closed (idle timeout, expiry:
 * 410 SESSION_EXPIRED) is replaced once, transparently (05_API_CONTRACTS §2.5). A revoked session, or one whose target
 * or policy changed, is dropped and the error shown: the next action opens a new session, decided afresh by policy.
 * A reloaded tab resumes the session it had (sessions count against the user's limit, and an abandoned one lingers
 * until its idle timeout), after checking with the server that it is still the user's live files-session.
 */
export class RemoteFileSessions {
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(
    private readonly api: FilesApi,
    private readonly store?: SessionStore,
  ) {}

  async call<T>(targetId: string, op: FsOp, body: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const session = this.session(targetId);
      const sessionId = await session;
      try {
        return (await this.api.fileOp(sessionId, op, body)) as T;
      } catch (error) {
        const code = error instanceof RemoteApiError ? error.code : undefined;
        if (code === 'SESSION_EXPIRED' || code === 'SESSION_REVOKED' || code === 'TARGET_NOT_ALLOWED') {
          if (this.sessions.get(targetId) === session) this.forget(targetId);
          if (code === 'SESSION_EXPIRED' && attempt === 0) continue;
        }
        throw error;
      }
    }
  }

  private session(targetId: string): Promise<string> {
    let session = this.sessions.get(targetId);
    if (session === undefined) {
      session = this.resume(targetId).then(
        async (resumed) => resumed ?? (await this.api.openFilesSession(targetId)).sessionId,
      );
      this.sessions.set(targetId, session);
      session.then(
        (id) => {
          this.store?.set(targetId, id);
        },
        () => {
          if (this.sessions.get(targetId) === session) this.forget(targetId);
        },
      );
    }
    return session;
  }

  private forget(targetId: string): void {
    this.sessions.delete(targetId);
    this.store?.delete(targetId);
  }

  /** The session this tab used before a reload, if the server still has it live for this user and target. */
  private async resume(targetId: string): Promise<string | undefined> {
    const stored = this.store?.get(targetId);
    if (stored === undefined) return undefined;
    try {
      const mine = await this.api.listSessions();
      const live = mine.find(
        (s) => s.id === stored && s.kind === 'files' && s.targetId === targetId && LIVE.has(s.state),
      );
      if (live === undefined) this.store?.delete(targetId);
      return live?.id;
    } catch {
      return undefined;
    }
  }
}

const CHUNK = 0x8000;

/** Base64 of up to 10 MB without building one huge argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
