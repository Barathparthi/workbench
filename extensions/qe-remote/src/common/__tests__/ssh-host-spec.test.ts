import { describe, expect, it } from 'vitest';

import { aliasProblem, parseHostSpec, suggestedAlias } from '../ssh-host-spec';

describe('"Add SSH Host…" input', () => {
  it('reads host, user@host, user@host:port and bracketed IPv6', () => {
    expect(parseHostSpec('lab-a.example.com')).toEqual({ host: 'lab-a.example.com' });
    expect(parseHostSpec(' qe@10.20.1.5 ')).toEqual({ host: '10.20.1.5', user: 'qe' });
    expect(parseHostSpec('qe@lab-a.example.com:2222')).toEqual({
      host: 'lab-a.example.com',
      user: 'qe',
      port: 2222,
    });
    expect(parseHostSpec('qe@[2001:db8::7]:2200')).toEqual({ host: '2001:db8::7', user: 'qe', port: 2200 });
    expect(parseHostSpec('2001:db8::7')).toEqual({ host: '2001:db8::7' });
  });

  it('says why anything else cannot be used', () => {
    for (const bad of [
      '',
      'two words',
      'h\nProxyCommand sh',
      'h -oProxyCommand=sh',
      'a b@h',
      'q/e@h',
      'h:0',
      'h:65536',
      'h:x',
    ])
      expect(typeof parseHostSpec(bad)).toBe('string');
  });

  it('suggests a usable name', () => {
    expect(suggestedAlias('lab-a.example.com')).toBe('lab-a');
    expect(suggestedAlias('10.20.1.5')).toBe('10.20.1.5');
    expect(suggestedAlias('2001:db8::7')).toBe('2001-db8--7');
    expect(aliasProblem('lab-a')).toBeUndefined();
    expect(aliasProblem('lab a')).toBeDefined();
    expect(aliasProblem('*')).toBeDefined();
  });
});
