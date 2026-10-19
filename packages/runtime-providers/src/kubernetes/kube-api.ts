import { readFileSync } from 'node:fs';
import { request } from 'node:https';

/** The few Kubernetes REST calls the provider makes — a fake in unit tests. */
export interface KubeApi {
  call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

export interface KubeConnection {
  readonly server: string;
  readonly token: string;
  readonly ca: string;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** In-cluster connection from the pod's service account (the control plane's least-privilege Role, Phase 16). */
export function inClusterConnection(
  env: Readonly<Record<string, string | undefined>> = process.env,
): KubeConnection {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (host === undefined) throw new Error('not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)');
  return {
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
    ca: readFileSync(`${SA_DIR}/ca.crt`, 'utf8'),
  };
}

/** HTTPS client verifying the cluster CA, with a bearer token and a timeout on every call. */
export function kubeApi(connection: KubeConnection, timeoutMs = 30_000): KubeApi {
  const base = new URL(connection.server);
  return {
    call: (method, path, body) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
          {
            host: base.hostname,
            port: base.port || 443,
            method,
            path,
            ca: connection.ca,
            timeout: timeoutMs,
            headers: {
              authorization: `Bearer ${connection.token}`,
              accept: 'application/json',
              ...(payload && { 'content-type': 'application/json', 'content-length': payload.length }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown = text;
              try {
                parsed = JSON.parse(text);
              } catch {
                // non-JSON error bodies stay text
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          },
        );
        req.on('timeout', () =>
          req.destroy(new Error(`kubernetes api timeout after ${String(timeoutMs)} ms`)),
        );
        req.on('error', reject);
        req.end(payload);
      }),
  };
}
