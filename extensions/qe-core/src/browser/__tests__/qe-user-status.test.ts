import { describe, expect, it } from 'vitest';

import { cookieValue, parseMe, userStatus } from '../qe-user-status';

describe('QE user status', () => {
  it('parses the /api/v1/me answer it needs and ignores the rest', () => {
    expect(parseMe({ username: 'bob', displayName: 'Bob', roles: ['qe.user', 1], permissions: [] })).toEqual({
      username: 'bob',
      displayName: 'Bob',
      roles: ['qe.user'],
    });
  });

  it.each([null, 'x', {}, { username: 'a', displayName: 'A' }, { username: 1, displayName: 'A', roles: [] }])(
    'rejects %j',
    (body) => {
      expect(parseMe(body)).toBeUndefined();
    },
  );

  it('shows the username and the roles', () => {
    expect(userStatus({ username: 'bob', displayName: 'Bob L', roles: ['lab.a.user', 'qe.user'] })).toEqual({
      text: '$(account) bob',
      tooltip: 'Bob L — roles: lab.a.user, qe.user. Click to sign out.',
    });
    expect(userStatus({ username: 'x', displayName: 'X', roles: [] }).tooltip).toContain('roles: none');
  });

  it('reads the CSRF cookie', () => {
    expect(cookieValue('a=1; qews_csrf=t%3D1', 'qews_csrf')).toBe('t=1');
    expect(cookieValue('qews_csrfx=1', 'qews_csrf')).toBeUndefined();
  });
});
