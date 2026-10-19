import { request } from 'node:http';

/** A response from the Docker Engine API. */
export interface EngineResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The minimal Docker Engine API surface the provider uses — a fake in unit tests, HTTP over a socket otherwise. */
export interface DockerEngine {
  call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<EngineResponse>;
}

export class DockerEngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`docker engine ${String(status)}: ${message}`);
    this.name = 'DockerEngineError';
  }
}

/** Default socket: the named pipe on Windows, the Unix socket elsewhere (DOCKER_SOCKET overrides). */
export const defaultDockerSocket = (): string =>
  process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';

const API_VERSION = 'v1.43'; // Docker 24+; every endpoint used here exists since well before.

/** Docker Engine API over the local socket, with a timeout on every call. */
export function socketEngine(socketPath = defaultDockerSocket(), timeoutMs = 60_000): DockerEngine {
  return {
    call: (method, path, body) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
          {
            socketPath,
            method,
            path: `/${API_VERSION}${path}`,
            headers: {
              host: 'docker',
              ...(payload && { 'content-type': 'application/json', 'content-length': payload.length }),
            },
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown = text;
              if (res.headers['content-type']?.includes('json')) {
                try {
                  parsed = JSON.parse(text);
                } catch {
                  // image pulls stream newline-delimited JSON; keep the text
                }
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          },
        );
        req.on('timeout', () =>
          req.destroy(new Error(`docker engine timeout after ${String(timeoutMs)} ms`)),
        );
        req.on('error', reject);
        req.end(payload);
      }),
  };
}

/** Throws unless the status is one of `ok`; returns the body. */
export async function expectStatus(
  engine: DockerEngine,
  ok: readonly number[],
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<EngineResponse> {
  const res = await engine.call(method, path, body);
  if (!ok.includes(res.status)) {
    const message =
      typeof res.body === 'object' && res.body !== null && 'message' in res.body
        ? String(res.body.message)
        : `${method} ${path}`;
    throw new DockerEngineError(res.status, message);
  }
  return res;
}
