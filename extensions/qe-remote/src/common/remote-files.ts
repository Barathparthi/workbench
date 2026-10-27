import type { FsOp } from '@qe/contracts';

import { RemoteApiError } from './remote-client';

/** `qe-ssh://<targetId>/<path relative to the target's remoteRoot>` (PHASE_09 §9.4). */
export const QE_SSH_SCHEME = 'qe-ssh';

/** The URI of a target's remote folder (its remoteRoot). */
export const remoteRootUri = (targetId: string): string => `${QE_SSH_SCHEME}://${targetId}/`;

/** The API path of a URI path: relative to remoteRoot, no leading slash (`/` → `''`). */
export const relativePath = (uriPath: string): string => uriPath.replace(/^\/+/, '');

export interface FilesApi {
  openFilesSession(targetId: string): Promise<{ sessionId: string }>;
  fileOp(sessionId: string, op: FsOp, body: object): Promise<unknown>;
}

/**
 * The files-session of each target, opened on first use. A session the server has closed (idle timeout, expiry:
 * 410 SESSION_EXPIRED) is replaced once, transparently (05_API_CONTRACTS §2.5). A revoked session, or one whose target
 * or policy changed, is dropped and the error shown: the next action opens a new session, decided afresh by policy.
 */
export class RemoteFileSessions {
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(private readonly api: FilesApi) {}

  async call<T>(targetId: string, op: FsOp, body: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const session = this.session(targetId);
      const sessionId = await session;
      try {
        return (await this.api.fileOp(sessionId, op, body)) as T;
      } catch (error) {
        const code = error instanceof RemoteApiError ? error.code : undefined;
        if (code === 'SESSION_EXPIRED' || code === 'SESSION_REVOKED' || code === 'TARGET_NOT_ALLOWED') {
          if (this.sessions.get(targetId) === session) this.sessions.delete(targetId);
          if (code === 'SESSION_EXPIRED' && attempt === 0) continue;
        }
        throw error;
      }
    }
  }

  private session(targetId: string): Promise<string> {
    let session = this.sessions.get(targetId);
    if (session === undefined) {
      session = this.api.openFilesSession(targetId).then((s) => s.sessionId);
      this.sessions.set(targetId, session);
      session.catch(() => {
        if (this.sessions.get(targetId) === session) this.sessions.delete(targetId);
      });
    }
    return session;
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
