const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  configureSshAuth,
  forgetSshPassword,
  getSshAskpassEnv,
  getSshAskpassScript,
  hasSshPassword,
  isSshAuthFailure,
  saveSshPassword
} = require('../out/sshAuth.js');
const { OpenDevContainerError } = require('../out/errors.js');

async function createStorage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-ssh-auth-'));
  configureSshAuth(dir, async () => undefined);
  return dir;
}

test('saved passwords create a private file plus askpass script', async () => {
  const dir = await createStorage();

  assert.equal(await hasSshPassword('build-01'), false);
  assert.equal(await getSshAskpassEnv('build-01'), undefined);
  assert.equal(await getSshAskpassScript('build-01'), undefined);

  await saveSshPassword('build-01', 'letmein');

  assert.equal(await hasSshPassword('build-01'), true);
  const env = await getSshAskpassEnv('build-01');
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(env.DISPLAY, ':0');
  assert.match(await fs.readFile(env.SSH_ASKPASS, 'utf8'), /^#!\/bin\/sh\ncat '/);
  assert.equal((await fs.stat(env.SSH_ASKPASS)).mode & 0o777, 0o700);
  assert.equal(await getSshAskpassScript('build-01'), env.SSH_ASKPASS);

  const files = await fs.readdir(dir);
  const passwordFile = files.find((name) => name.startsWith('password-'));
  const passwordPath = path.join(dir, passwordFile);
  assert.equal((await fs.stat(passwordPath)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(passwordPath, 'utf8'), 'letmein\n');

  await forgetSshPassword('build-01');
  assert.equal(await hasSshPassword('build-01'), false);
  assert.equal(await getSshAskpassEnv('build-01'), undefined);
});

test('password lookups stay empty without a configured storage', async () => {
  configureSshAuth('', async () => undefined);
  assert.equal(await hasSshPassword('build-01'), false);
  assert.equal(await getSshAskpassScript('build-01'), undefined);
});

test('isSshAuthFailure only matches ssh-level denials', () => {
  assert.equal(
    isSshAuthFailure(new OpenDevContainerError('DOCKER_EXEC_FAILED', 'Command failed: ssh build-01 docker ps', 'root@build-01: Permission denied (publickey,password).', 255)),
    true
  );
  assert.equal(
    isSshAuthFailure(new OpenDevContainerError('DOCKER_DAEMON_UNAVAILABLE', 'The container engine is not reachable.', 'permission denied while connecting to the docker socket', 1)),
    false
  );
  assert.equal(
    isSshAuthFailure(new OpenDevContainerError('DOCKER_EXEC_FAILED', 'Command failed: ssh build-01 docker ps', 'Connection timed out', 255)),
    false
  );
});
