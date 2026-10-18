const assert = require('node:assert/strict');
const test = require('node:test');
const { isSshRemote, parseSshTargetFromAuthority, resolveSshTarget, parseManagedHostTarget } = require('../out/sshTarget.js');
const { buildProxyCommand, upsertManagedHostBlock } = require('../out/sshConfig.js');
const { splitShellWords } = require('../out/shell.js');
const { buildSshInvocation, execContainerCli } = require('../out/containerExec.js');

test('isSshRemote accepts the identifier Remote SSH reports', () => {
  assert.equal(isSshRemote('ssh-remote'), true);
  assert.equal(isSshRemote('SSH-Remote'), true);
  assert.equal(isSshRemote('ssh'), true);
  assert.equal(isSshRemote('wsl'), false);
  assert.equal(isSshRemote(undefined), false);
});

test('parseSshTargetFromAuthority extracts the SSH alias from a remote workspace authority', () => {
  assert.equal(parseSshTargetFromAuthority('ssh-remote+build-01'), 'build-01');
  assert.equal(parseSshTargetFromAuthority('ssh-remote+build-01+7b22686f7374227d'), 'build-01');
  assert.equal(parseSshTargetFromAuthority('ssh-remote+user@host'), 'user@host');
  assert.equal(parseSshTargetFromAuthority('ssh-remote+'), undefined);
  assert.equal(parseSshTargetFromAuthority('wsl+ubuntu'), undefined);
});

test('parseSshTargetFromAuthority decodes Trae hex-encoded connection JSON', () => {
  const hex = (value) => Buffer.from(value, 'utf8').toString('hex');

  assert.equal(parseSshTargetFromAuthority(`ssh-remote+${hex('{"hostName":"192.0.2.10"}')}`), '192.0.2.10');
  assert.equal(parseSshTargetFromAuthority(`ssh-remote+${hex('{"hostName":"build.lan","username":"dev"}')}`), 'dev@build.lan');
  assert.equal(parseSshTargetFromAuthority(`ssh-remote+${hex('{"hostName":"build.lan","user":"dev","port":2222}')}`), 'ssh://dev@build.lan:2222');
  assert.equal(parseSshTargetFromAuthority(`ssh-remote+${hex('{"hostName":"build.lan","port":22,"username":"dev"}')}`), 'dev@build.lan');
  // Hex payloads without a usable hostName fall through unchanged.
  assert.equal(parseSshTargetFromAuthority(`ssh-remote+${hex('{"something":"else"}')}`), hex('{"something":"else"}'));
});

test('resolveSshTarget prefers the configured host and only derives it inside SSH windows', () => {
  assert.deepEqual(resolveSshTarget({ configuredHost: 'box-a', remoteName: 'ssh-remote', authority: 'ssh-remote+build-01' }), {
    target: 'box-a',
    source: 'setting'
  });
  assert.deepEqual(resolveSshTarget({ remoteName: 'ssh-remote', authority: 'ssh-remote+build-01' }), {
    target: 'build-01',
    source: 'workspace-authority'
  });
  assert.deepEqual(resolveSshTarget({ remoteName: undefined, authority: 'ssh-remote+build-01' }), { source: 'none' });
  assert.deepEqual(resolveSshTarget({ remoteName: 'ssh-remote' }), { source: 'none' });
});

test('splitShellWords keeps quoted runs together', () => {
  assert.deepEqual(splitShellWords(`env 'SSH_ASKPASS=/a b.sh' DISPLAY=:0 ssh build-01 "docker ps"`), [
    'env',
    'SSH_ASKPASS=/a b.sh',
    'DISPLAY=:0',
    'ssh',
    'build-01',
    'docker ps'
  ]);
});

test('parseManagedHostTarget recovers the host that runs the container', () => {
  const alias = 'odc-odc-podman-u24-6159e4';
  const remoteBlock = [
    `# >>> open-dev-container ${alias}`,
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    '  User root',
    `  ProxyCommand env 'SSH_ASKPASS=/storage/ssh-auth/askpass-abc.sh' SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh 192.0.2.10 "'podman' 'exec' '-i' '-u' '0' 'abc123' '/usr/sbin/sshd' '-i' '-f' '/tmp/sshd_config'"`,
    `# <<< open-dev-container ${alias}`,
    ''
  ].join('\n');

  assert.equal(parseManagedHostTarget(remoteBlock, alias), '192.0.2.10');

  // A container created on the local machine has no ssh hop to step up to.
  const localBlock = [
    `# >>> open-dev-container ${alias}`,
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  ProxyCommand podman exec -i -u 0 abc123 /usr/sbin/sshd -i -f /tmp/sshd_config`,
    `# <<< open-dev-container ${alias}`,
    ''
  ].join('\n');

  assert.equal(parseManagedHostTarget(localBlock, alias), undefined);

  // An unknown alias, or a block that points back at itself, keeps the caller
  // on its original target.
  assert.equal(parseManagedHostTarget(remoteBlock, 'odc-other'), undefined);

  const selfReferential = [
    `# >>> open-dev-container ${alias}`,
    `Host ${alias}`,
    `  ProxyCommand ssh ${alias} "'podman' 'exec' ..."`,
    `# <<< open-dev-container ${alias}`
  ].join('\n');
  assert.equal(parseManagedHostTarget(selfReferential, alias), undefined);
});

test('parseManagedHostTarget reads a quoted jump destination', () => {
  const alias = 'odc-box-abc123';
  const content = [
    `# >>> open-dev-container ${alias}`,
    `Host ${alias}`,
    `  ProxyCommand ssh 'dev@build.lan' "'docker' 'exec'..."`,
    `# <<< open-dev-container ${alias}`
  ].join('\n');

  assert.equal(parseManagedHostTarget(content, alias), 'dev@build.lan');
});

test('buildProxyCommand runs docker exec locally when no remote host is active', () => {
  const options = {
    dockerPath: 'docker',
    containerId: 'abc123',
    identityFile: '/tmp/key',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/sshd_config'
  };

  assert.equal(buildProxyCommand(options), 'docker exec -i -u 0 abc123 /usr/sbin/sshd -i -f /tmp/sshd_config');
});

test('buildProxyCommand forwards docker exec through the remote host when one is active', () => {
  const options = {
    dockerPath: 'docker',
    containerId: 'abc123',
    identityFile: '/tmp/key',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/sshd_config',
    sshTarget: 'build-01'
  };

  assert.equal(
    buildProxyCommand(options),
    `ssh build-01 "'docker' 'exec' '-i' '-u' '0' 'abc123' '/usr/sbin/sshd' '-i' '-f' '/tmp/sshd_config'"`
  );
});

test('buildProxyCommand keeps the askpass prefix as separate shell words', () => {
  const options = {
    dockerPath: 'docker',
    containerId: 'abc123',
    identityFile: '/tmp/key',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/sshd_config',
    sshTarget: 'build-01',
    askpassScript: '/storage/ssh-auth/askpass-abc123.sh'
  };

  assert.equal(
    buildProxyCommand(options),
    `env 'SSH_ASKPASS=/storage/ssh-auth/askpass-abc123.sh' SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh build-01 "'docker' 'exec' '-i' '-u' '0' 'abc123' '/usr/sbin/sshd' '-i' '-f' '/tmp/sshd_config'"`
  );
});

test('a managed block written for a remote host parses back to that host', () => {
  const alias = 'odc-odc-podman-u24-6159e4';
  const options = {
    dockerPath: 'podman',
    containerId: '6159e4b7c9e8',
    identityFile: '/key',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/sshd_config',
    sshTarget: '192.168.31.135',
    askpassScript: '/storage/ssh-auth/askpass-abc.sh'
  };

  // The writer (buildProxyCommand) and the reader (parseManagedHostTarget) share
  // one format, so this assertion pins them together: changing only one side
  // would otherwise silently break host resolution inside container windows.
  const content = upsertManagedHostBlock('', alias, options);
  assert.equal(parseManagedHostTarget(content, alias), '192.168.31.135');

  const localContent = upsertManagedHostBlock('', alias, { ...options, sshTarget: undefined, askpassScript: undefined });
  assert.equal(parseManagedHostTarget(localContent, alias), undefined);
});

test('buildSshInvocation quotes every argument so the remote shell cannot expand it', () => {
  assert.deepEqual(buildSshInvocation('build-01', 'docker', ['ps', '--format', '{{json .}}']), {
    file: 'ssh',
    args: ['-o', 'StrictHostKeyChecking=accept-new', 'build-01', "'docker' 'ps' '--format' '{{json .}}'"]
  });
});

test('execContainerCli uses the CLI directly without a remote host and ssh with one', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    return { stdout: 'ok', stderr: '' };
  };

  await execContainerCli('docker', ['ps', '-a'], undefined, {}, run);
  await execContainerCli('docker', ['ps', '-a'], 'build-01', {}, run);

  assert.deepEqual(calls, [
    ['docker', ['ps', '-a']],
    ['ssh', ['-o', 'StrictHostKeyChecking=accept-new', 'build-01', "'docker' 'ps' '-a'"]]
  ]);
});

test('execContainerCli asks for an SSH password after an auth failure and retries', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { configureSshAuth, getSshAskpassEnv } = require('../out/sshAuth.js');
  const { OpenDevContainerError } = require('../out/errors.js');

  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-ssh-auth-'));
  let prompted = 0;
  configureSshAuth(storageDir, async (target) => {
    prompted += 1;
    assert.equal(target, 'build-01');
    return 'letmein';
  });

  const calls = [];
  let failedOnce = false;
  const run = async (file, args, options) => {
    calls.push([file, args, options.env?.SSH_ASKPASS]);
    if (!failedOnce) {
      failedOnce = true;
      throw new OpenDevContainerError('DOCKER_EXEC_FAILED', 'Command failed: ssh build-01 docker ps', 'root@build-01: Permission denied (publickey,password).', 255);
    }
    return { stdout: 'ok', stderr: '' };
  };

  const result = await execContainerCli('docker', ['ps'], 'build-01', {}, run);

  assert.equal(result.stdout, 'ok');
  assert.equal(prompted, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2], undefined);
  assert.equal(typeof calls[1][2], 'string');
  assert.equal((await getSshAskpassEnv('build-01')).SSH_ASKPASS_REQUIRE, 'force');

  await require('../out/sshAuth.js').forgetSshPassword('build-01');
});
