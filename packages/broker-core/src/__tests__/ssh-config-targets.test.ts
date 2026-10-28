import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sshConfigTargetSource } from '../index.js';

const HOME = '/home/ada';

function source(files: Record<string, string>) {
  return sshConfigTargetSource({
    home: HOME,
    localUser: 'ada',
    read: (path) => Promise.resolve(files[path]),
  });
}
const CONFIG = join(HOME, '.ssh', 'config');
const QE_HOSTS = join(HOME, '.qe-workspace', 'ssh_hosts');

describe('personal targets from ~/.ssh/config', () => {
  it('lists concrete hosts with their effective settings (first value wins, IdentityFile accumulates)', async () => {
    const targets = await source({
      [CONFIG]: `
# global defaults come first in the file and apply everywhere
User fallback-user

Host lab-a lab-a-alias
  HostName 10.20.1.5
  Port 2222
  IdentityFile ~/.ssh/id_lab
  IdentityFile ~/.ssh/id_%u_%h

Host *.corp
  User corp-user
  IdentitiesOnly yes

Host build.corp
  HostName build.example.corp
  ProxyJump bastion.corp

Host *
  IdentityFile ~/.ssh/id_default
  Port 2200
`,
    }).list();

    expect(targets.map((t) => t.alias)).toEqual(['build.corp', 'lab-a', 'lab-a-alias']);
    expect(targets.find((t) => t.alias === 'lab-a')).toEqual({
      id: 'personal-lab-a',
      alias: 'lab-a',
      host: '10.20.1.5',
      port: 2222,
      user: 'fallback-user',
      identityFiles: [
        join(HOME, '.ssh', 'id_lab'),
        join(HOME, '.ssh', 'id_ada_10.20.1.5'),
        join(HOME, '.ssh', 'id_default'),
      ],
      identitiesOnly: false,
      source: 'ssh-config',
    });
    expect(targets.find((t) => t.alias === 'build.corp')).toMatchObject({
      host: 'build.example.corp',
      port: 2200,
      user: 'fallback-user', // the global User comes before Host *.corp in the file, so it wins
      identitiesOnly: true,
      proxyJump: 'bastion.corp',
    });
  });

  it('uses OpenSSH defaults: alias as HostName, port 22, the local user, no key files', async () => {
    const [target] = await source({ [CONFIG]: 'Host plain-box\n' }).list();
    expect(target).toMatchObject({ host: 'plain-box', port: 22, user: 'ada', identityFiles: [] });
  });

  it('skips wildcard-only and negated patterns, and honours negation when matching', async () => {
    const targets = await source({
      [CONFIG]: `
Host * !skip
Host keep skip
  HostName %h.lab
Host *.lab !skip.lab
  Port 2022
Host !keep
  Port 1
`,
    }).list();
    expect(targets.map((t) => `${t.alias} ${t.host}:${String(t.port)}`)).toEqual([
      'keep keep.lab:22',
      'skip skip.lab:22',
    ]);
  });

  it('adds the hosts added in the IDE, without overriding ~/.ssh/config', async () => {
    const targets = await source({
      [CONFIG]: 'Host shared\n  HostName from-ssh-config\n',
      [QE_HOSTS]: 'Host shared\n  HostName from-qe\nHost added-in-ide\n  HostName 192.168.1.7\n',
    }).list();
    expect(targets.map((t) => `${t.alias}=${t.host} (${t.source})`)).toEqual([
      'added-in-ide=192.168.1.7 (qe-hosts)',
      'shared=from-ssh-config (ssh-config)',
    ]);
  });

  it('expands ~, %%, %d, %n, %p and %r, takes relative key files from ~/.ssh, and ignores IdentityFile none', async () => {
    const [target] = await source({
      [CONFIG]: `
Host box
  User remote
  IdentityFile none
  IdentityFile keys/%n-%p-%r
  IdentityFile %d/elsewhere/key
  IdentityFile /abs/100%%
`,
    }).list();
    expect(target?.identityFiles).toEqual([
      join(HOME, '.ssh', 'keys', 'box-22-remote'),
      join(HOME, 'elsewhere', 'key'),
      join('/abs', '100%'),
    ]);
  });

  it('reports entries it cannot use instead of guessing', async () => {
    const s = source({
      [CONFIG]: `
Host bad-port
  Port 99999
Host bad-host
  HostName "two words"
Host bad-user
  User "a b"
Host bad-token
  IdentityFile ~/.ssh/%C
Host good
`,
    });
    expect((await s.list()).map((t) => t.alias)).toEqual(['good']);
    expect(await s.problems()).toEqual([
      'bad-port: Port is not a port number',
      'bad-host: HostName is not a host name or address',
      'bad-user: User is not a user name',
      'bad-token: IdentityFile uses an unsupported %-token',
    ]);
  });

  it('never follows Match blocks (Match exec would run a command)', async () => {
    const [target] = await source({
      [CONFIG]: 'Host box\nMatch exec "touch /tmp/pwned"\n  Port 2222\n',
    }).list();
    expect(target?.port).toBe(22);
  });

  it('keeps aliases URI-safe and finds them case-insensitively, as ssh matches them', async () => {
    const s = source({ [CONFIG]: 'Host Lab-A\nHost we%ird\n' });
    expect((await s.list()).map((t) => t.id)).toEqual(['personal-Lab-A']);
    expect(await s.get('personal-lab-a')).toMatchObject({ alias: 'Lab-A' });
    expect(await s.problems()).toEqual([
      "we%ird: use only letters, digits, '.', '_' and '-' in the Host alias",
    ]);
  });

  it('finds a target by id, and lists nothing without configuration files', async () => {
    const s = source({ [CONFIG]: 'Host box\n' });
    expect(await s.get('personal-box')).toMatchObject({ alias: 'box' });
    expect(await s.get('personal-nope')).toBeUndefined();
    expect(await source({}).list()).toEqual([]);
  });
});
