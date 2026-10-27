/**
 * An in-process SSH server (ssh2's own server) for unit tests: real handshakes, host keys, public-key auth, PTY
 * requests and window changes — no Docker needed. The "shell" echoes input, answers Ctrl+C with "^C" and exits
 * on "exit\r".
 */
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

import ssh2 from 'ssh2';

import { ed25519KeyPair } from './ssh-keys.js';

export interface TestSshServer {
  readonly port: number;
  readonly hostKeyBlob: Buffer;
  readonly clientKey: Buffer;
  readonly events: string[];
  close(): Promise<void>;
}

export async function startSshServer(): Promise<TestSshServer> {
  const host = ed25519KeyPair();
  const client = ed25519KeyPair();
  const allowed = ssh2.utils.parseKey(client.public);
  const hostParsed = ssh2.utils.parseKey(host.public);
  if (allowed instanceof Error || hostParsed instanceof Error) throw new Error('key generation failed');
  const events: string[] = [];

  const server = new ssh2.Server({ hostKeys: [host.private] }, (conn) => {
    conn.on('authentication', (ctx) => {
      events.push(`auth:${ctx.method}`);
      if (
        ctx.method === 'publickey' &&
        ctx.key.algo === allowed.type &&
        timingSafeEqual(ctx.key.data, allowed.getPublicSSH()) &&
        (ctx.signature === undefined || (ctx.blob !== undefined && allowed.verify(ctx.blob, ctx.signature)))
      ) {
        ctx.accept();
        return;
      }
      ctx.reject(['publickey']);
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, _reject, info) => {
          events.push(`pty:${String(info.cols)}x${String(info.rows)}:${info.term}`);
          acceptPty();
        });
        session.on('window-change', (acceptWc, _reject, info) => {
          events.push(`resize:${String(info.cols)}x${String(info.rows)}`);
          // Typed as always present, but ssh2 passes undefined when the client wants no reply.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          acceptWc?.();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('ready$ ');
          let line = '';
          stream.on('data', (d: Buffer) => {
            for (const ch of d.toString('utf8')) {
              if (ch === '\x03') {
                events.push('ctrl-c');
                stream.write('^C\r\n');
                line = '';
              } else if (ch === '\r') {
                if (line === 'exit') {
                  stream.exit(0);
                  stream.end();
                  return;
                }
                stream.write(`\r\necho:${line}\r\n`);
                line = '';
              } else {
                line += ch;
              }
            }
          });
        });
      });
    });
    conn.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hostKeyBlob: hostParsed.getPublicSSH(),
    clientKey: Buffer.from(client.private),
    events,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
