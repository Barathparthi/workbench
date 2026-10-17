// Minimal client for the stub broker's session/stream/fs contract (01_ARCHITECTURE/05_API_CONTRACTS §2.4, §4).
// Runs in the browser frontend: SSH reachability stays in the broker, never in the workspace runtime (P9).
export const BROKER = 'http://127.0.0.1:8082';
export const TARGET_ID = 'tg_lab1';

export interface OpenedSession {
  sessionId: string;
  streamUrl: string;
  ticket?: string;
}

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function openSession(kind: 'terminal' | 'files', terminal?: { cols: number; rows: number }): Promise<OpenedSession> {
  const res = await fetch(`${BROKER}/api/v1/targets/${TARGET_ID}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, terminal }),
  });
  if (!res.ok) throw new BrokerError(res.status, ((await res.json()) as { code: string }).code);
  return (await res.json()) as OpenedSession;
}

export async function fsCall<T>(sessionId: string, op: string, body: object): Promise<T> {
  const res = await fetch(`${BROKER}/api/v1/sessions/${sessionId}/fs/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { code?: string };
  if (!res.ok) throw new BrokerError(res.status, json.code ?? 'INTERNAL_ERROR');
  return json;
}

/** qews.v1 stream: binary 0x00 = input, 0x01 = output; JSON control frames. */
export function openStream(session: OpenedSession, handlers: { onOutput(text: string): void; onControl(msg: { t: string }): void }) {
  const ws = new WebSocket(`${BROKER.replace(/^http/, 'ws')}${session.streamUrl}`, ['qews.v1', `ticket.${session.ticket}`]);
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const queue: (string | Uint8Array)[] = [];
  const sendRaw = (frame: string | Uint8Array) => (ws.readyState === WebSocket.OPEN ? ws.send(frame) : queue.push(frame));
  ws.onopen = () => queue.splice(0).forEach((f) => ws.send(f));
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return handlers.onControl(JSON.parse(e.data) as { t: string });
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    if (bytes[0] === 0x01) handlers.onOutput(decoder.decode(bytes.subarray(1), { stream: true }));
  };
  return {
    input(text: string) {
      const data = encoder.encode(text);
      const frame = new Uint8Array(data.length + 1);
      frame.set(data, 1);
      sendRaw(frame);
    },
    resize(cols: number, rows: number) {
      sendRaw(JSON.stringify({ t: 'resize', cols, rows }));
    },
    close() {
      ws.close(1000);
    },
    onClose(cb: () => void) {
      ws.addEventListener('close', cb);
    },
  };
}

export const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
