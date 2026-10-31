import { z } from 'zod';

import type { TestRunResultRequest } from './test-runs.js';

/**
 * `qews.v1` remote terminal protocol (05_API_CONTRACTS §4). Control messages are JSON text frames; terminal data
 * is binary with a one-byte type prefix: 0x00 input (client → server), 0x01 output (server → client).
 * Browser-safe: only `Uint8Array`, no Node APIs.
 */
export const QEWS_PROTOCOL = 'qews.v1';
export const TICKET_PROTOCOL_PREFIX = 'ticket.';

export const FRAME_INPUT = 0x00;
export const FRAME_OUTPUT = 0x01;
/** Largest WebSocket message either side accepts. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Largest input payload per frame. */
export const MAX_INPUT_BYTES = 16 * 1024;
/** Output is split into frames of at most this size. */
export const MAX_OUTPUT_BYTES = 32 * 1024;

export const CloseCodes = {
  NORMAL: 1000,
  AUTH: 4001,
  FORBIDDEN: 4003,
  PROTOCOL: 4008,
  EXPIRED: 4010,
  REVOKED: 4011,
  SHUTTING_DOWN: 4013,
  INTERNAL: 4500,
} as const;
export type CloseCode = (typeof CloseCodes)[keyof typeof CloseCodes];

export const ClientControl = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500),
  }),
  z.strictObject({ t: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGQUIT']) }),
  z.strictObject({ t: z.literal('close') }),
  z.strictObject({
    t: z.literal('ack'),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(1 << 30),
  }),
]);
export type ClientControl = z.infer<typeof ClientControl>;

export type ServerControl =
  | { t: 'status'; state: 'CONNECTING' | 'ACTIVE' | 'CLOSING' | 'CLOSED'; reason?: string }
  | { t: 'hostkey'; algorithm: string; fingerprintSha256: string; verified: true }
  | { t: 'exit'; code: number | null; signal: string | null }
  | { t: 'error'; code: string; message: string }
  /** An exec session's test run ended: its result as recorded (PHASE_11 §11.4); `problem` when no report was read. */
  | { t: 'run'; result: TestRunResultRequest; problem?: string };

export type ClientFrame = { kind: 'input'; data: Uint8Array } | { kind: 'control'; message: ClientControl };

/** Decodes one client message; `undefined` means a protocol violation (the server closes with 4008). */
export function decodeClientFrame(data: Uint8Array | string, isBinary: boolean): ClientFrame | undefined {
  if (isBinary) {
    if (typeof data === 'string' || data.length < 1 || data[0] !== FRAME_INPUT) return undefined;
    if (data.length - 1 > MAX_INPUT_BYTES) return undefined;
    return { kind: 'input', data: data.subarray(1) };
  }
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  if (text.length > 1024) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ClientControl.safeParse(json);
  return parsed.success ? { kind: 'control', message: parsed.data } : undefined;
}

/** Splits terminal output into prefixed binary frames of at most MAX_OUTPUT_BYTES payload. */
export function encodeOutput(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_BYTES) {
    const chunk = data.subarray(offset, Math.min(offset + MAX_OUTPUT_BYTES, data.length));
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = FRAME_OUTPUT;
    frame.set(chunk, 1);
    frames.push(frame);
  }
  return frames;
}

/** Client side: input bytes as one or more prefixed frames. */
export function encodeInput(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_INPUT_BYTES) {
    const chunk = data.subarray(offset, Math.min(offset + MAX_INPUT_BYTES, data.length));
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = FRAME_INPUT;
    frame.set(chunk, 1);
    frames.push(frame);
  }
  return frames;
}

/** The ticket from `Sec-WebSocket-Protocol` (`qews.v1, ticket.<value>`); never from the URL. */
export function ticketFromProtocols(header: string | undefined): string | undefined {
  const protocols = (header ?? '').split(',').map((p) => p.trim());
  if (!protocols.includes(QEWS_PROTOCOL)) return undefined;
  const ticket = protocols
    .find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX))
    ?.slice(TICKET_PROTOCOL_PREFIX.length);
  return ticket !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(ticket) ? ticket : undefined;
}
