import { describe, expect, it } from 'vitest';

import {
  decodeClientFrame,
  encodeInput,
  encodeOutput,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  ticketFromProtocols,
} from '../index.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('qews.v1 codec', () => {
  it('decodes input frames and control messages', () => {
    expect(decodeClientFrame(Uint8Array.of(0x00, 0x61), true)).toEqual({
      kind: 'input',
      data: Uint8Array.of(0x61),
    });
    expect(decodeClientFrame('{"t":"resize","cols":80,"rows":24}', false)).toEqual({
      kind: 'control',
      message: { t: 'resize', cols: 80, rows: 24 },
    });
    expect(decodeClientFrame(bytes('{"t":"signal","signal":"SIGINT"}'), false)).toEqual({
      kind: 'control',
      message: { t: 'signal', signal: 'SIGINT' },
    });
  });

  it.each([
    ['empty binary', new Uint8Array(0), true],
    ['an output frame from a client', Uint8Array.of(0x01, 0x61), true],
    ['too much input', new Uint8Array(MAX_INPUT_BYTES + 2), true],
    ['a string marked binary', 'x', true],
    ['bad JSON', '{', false],
    ['an unknown message', '{"t":"exec"}', false],
    ['extra fields', '{"t":"close","x":1}', false],
    ['a huge resize', '{"t":"resize","cols":5000,"rows":24}', false],
    ['an unknown signal', '{"t":"signal","signal":"SIGKILL"}', false],
    ['an oversized text frame', `{"t":"close","pad":"${'x'.repeat(2000)}"}`, false],
  ] as const)('rejects %s', (_label, data, binary) => {
    expect(decodeClientFrame(data, binary)).toBeUndefined();
  });

  it('splits output and input into bounded, prefixed frames', () => {
    const out = encodeOutput(new Uint8Array(MAX_OUTPUT_BYTES * 2 + 1));
    expect(out.map((f) => f.length)).toEqual([MAX_OUTPUT_BYTES + 1, MAX_OUTPUT_BYTES + 1, 2]);
    expect(out.every((f) => f[0] === 0x01)).toBe(true);
    const input = encodeInput(new Uint8Array(MAX_INPUT_BYTES + 5));
    expect(input.map((f) => f.length)).toEqual([MAX_INPUT_BYTES + 1, 6]);
    expect(input.every((f) => f[0] === 0x00)).toBe(true);
    expect(encodeOutput(new Uint8Array(0))).toEqual([]);
  });

  it('reads the ticket from the subprotocol list only with qews.v1', () => {
    const ticket = 'a'.repeat(43);
    expect(ticketFromProtocols(`qews.v1, ticket.${ticket}`)).toBe(ticket);
    expect(ticketFromProtocols(`ticket.${ticket}`)).toBeUndefined();
    expect(ticketFromProtocols('qews.v1, ticket.short')).toBeUndefined();
    expect(ticketFromProtocols('qews.v1, ticket.bad/chars-aaaaaaaaaaaaaaaa')).toBeUndefined();
    expect(ticketFromProtocols(undefined)).toBeUndefined();
  });
});
