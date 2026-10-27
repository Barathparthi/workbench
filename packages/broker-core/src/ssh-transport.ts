import type { Duplex } from 'node:stream';

import ssh2 from 'ssh2';

import type { HostKeyVerifier } from './host-key.js';
import { mapSftpError, wrapSftp, type SftpChannel } from './sftp.js';

/** Where to connect: always a checked IP address (never a name — no second DNS lookup, no rebinding). */
export interface SshEndpoint {
  readonly address: string;
  readonly port: number;
  readonly username: string;
}

/** Key material held in memory only for the connect (never logged, never sent anywhere else). */
export type SshCredential =
  | { readonly kind: 'key'; readonly privateKey: Buffer; readonly passphrase?: string }
  | { readonly kind: 'password'; readonly password: string };

/** The PTY channel of a remote shell. */
export interface PtyChannel {
  write(data: Uint8Array): void;
  setWindow(rows: number, cols: number): void;
  pause(): void;
  resume(): void;
  end(): void;
  onData(listener: (data: Buffer) => void): void;
  onClose(listener: (code: number | null, signal: string | null) => void): void;
}

export interface SshConnection {
  shell(options: { cols: number; rows: number; term: string }): Promise<PtyChannel>;
  /** Opens the SFTP subsystem (one channel per files-session, reused across operations). */
  sftp(): Promise<SftpChannel>;
  close(): void;
  onClose(listener: () => void): void;
}

export interface SshTransport {
  connect(
    endpoint: SshEndpoint,
    credential: SshCredential,
    verifier: HostKeyVerifier,
    options?: { sock?: Duplex },
  ): Promise<SshConnection>;
}

/** Algorithm lists pinned explicitly (S4 rule 5): modern only, no SHA-1 host keys, no CBC. */
export const ALGORITHMS = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384'],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  cipher: ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr'],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
} as const;

export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * `ssh2` behind the transport interface (ADR-002). The verifier is mandatory: without one ssh2 accepts any host
 * key (S4 rule 1), so the type requires it and the connect refuses to start without it. Servers may not open
 * forwarded connections back to us.
 */
export const ssh2Transport: SshTransport = {
  connect(endpoint, credential, verifier, options) {
    if (typeof verifier.verify !== 'function') return Promise.reject(new Error('host key verifier required'));
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      let settled = false;
      client
        .on('ready', () => {
          settled = true;
          // SFTP and terminals are small request/response exchanges: with Nagle's algorithm each one waited for a
          // delayed ACK (~40 ms per SFTP round trip, measured in Phase 09). OpenSSH sets TCP_NODELAY likewise.
          client.setNoDelay(true);
          resolve(wrap(client));
        })
        .on('error', (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        })
        // Remote-initiated forwards (port/X11/agent) are never accepted (07_SECURITY T13).
        .on('tcp connection', (_info, _accept, rejectForward) => {
          rejectForward();
        })
        .on('x11', (_info, _accept, rejectX11) => {
          rejectX11();
        });
      client.connect({
        host: endpoint.address,
        port: endpoint.port,
        username: endpoint.username,
        ...(options?.sock !== undefined && { sock: options.sock }),
        ...(credential.kind === 'key'
          ? {
              privateKey: credential.privateKey,
              ...(credential.passphrase !== undefined && { passphrase: credential.passphrase }),
            }
          : { password: credential.password }),
        hostVerifier: (key: Buffer) => verifier.verify(key),
        algorithms: {
          kex: [...ALGORITHMS.kex],
          serverHostKey: [...ALGORITHMS.serverHostKey],
          cipher: [...ALGORITHMS.cipher],
          hmac: [...ALGORITHMS.hmac],
        },
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        agentForward: false,
        tryKeyboard: false,
      });
    });
  },
};

function wrap(client: ssh2.Client): SshConnection {
  return {
    shell: (opts) =>
      new Promise((resolve, reject) => {
        client.shell({ term: opts.term, cols: opts.cols, rows: opts.rows }, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({
            write: (data) => stream.write(data),
            setWindow: (rows, cols) => {
              stream.setWindow(rows, cols, 0, 0);
            },
            pause: () => stream.pause(),
            resume: () => stream.resume(),
            end: () => stream.end(),
            onData: (listener) => {
              stream.on('data', listener);
              stream.stderr.on('data', listener);
            },
            onClose: (listener) => {
              stream.on('close', (code: number | null, signal: string | null) => {
                listener(code ?? null, signal ?? null);
              });
            },
          });
        });
      }),
    sftp: () =>
      new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) reject(mapSftpError(error));
          else resolve(wrapSftp(sftp));
        });
      }),
    close: () => {
      client.end();
    },
    onClose: (listener) => {
      client.on('close', listener);
    },
  };
}
