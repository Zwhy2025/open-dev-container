const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPrepareSshdScript } = require('../out/containerProvisioner.js');
const { parseDockerContainerList, parseDockerInspect } = require('../out/dockerClient.js');
const { OpenDevContainerError } = require('../out/errors.js');
const { RecentConnectionStore, sanitizeRecentConnection } = require('../out/recentConnections.js');
const {
  quoteSshConfigValue,
  removeAllMarkedBlocks,
  removeMarkedBlock,
  upsertManagedHostBlock
} = require('../out/sshConfig.js');
const {
  createHostAlias,
  ensureSafeRemoteUser,
  resolveWorkspaceFolder,
  summarizeMounts
} = require('../out/utils.js');

test('parseDockerContainerList parses docker JSON lines', () => {
  const containers = parseDockerContainerList([
    '{"ID":"abc123","Image":"node:22","Names":"app","State":"running","Status":"Up 1 minute"}',
    '{"ID":"def456","Image":"redis","Names":"cache","State":"running","Status":"Up 2 minutes"}'
  ].join('\n'));

  assert.equal(containers.length, 2);
  assert.equal(containers[0].Names, 'app');
  assert.equal(containers[1].Image, 'redis');
});

test('parseDockerContainerList normalizes podman container output', () => {
  const containers = parseDockerContainerList(
    '{"Id":"8c5872883dfd","Image":"docker.io/library/archlinux:latest","Names":["archi"],"State":"running","Status":""}'
  );

  assert.equal(containers.length, 1);
  assert.equal(containers[0].ID, '8c5872883dfd');
  assert.equal(containers[0].Names, 'archi');
  assert.equal(containers[0].Status, 'running');
});

test('parseDockerContainerList reports invalid docker output', () => {
  assert.throws(
    () => parseDockerContainerList('not json'),
    (error) => error instanceof OpenDevContainerError && error.code === 'DOCKER_OUTPUT_PARSE_FAILED'
  );
  assert.throws(
    () => parseDockerContainerList('{"Image":"node:22","Names":["app"],"State":"running"}'),
    (error) => error instanceof OpenDevContainerError && error.code === 'DOCKER_OUTPUT_PARSE_FAILED'
  );
});

test('parseDockerInspect handles valid, empty, and invalid inspect output', () => {
  const inspect = parseDockerInspect('[{"Id":"abc","Config":{"WorkingDir":"/workspace"}}]', 'abc');
  assert.equal(inspect.Id, 'abc');
  assert.equal(inspect.Config.WorkingDir, '/workspace');

  assert.throws(
    () => parseDockerInspect('[]', 'missing'),
    (error) => error instanceof OpenDevContainerError && error.code === 'CONTAINER_NOT_FOUND'
  );
  assert.throws(
    () => parseDockerInspect('{bad', 'abc'),
    (error) => error instanceof OpenDevContainerError && error.code === 'DOCKER_OUTPUT_PARSE_FAILED'
  );
});

test('managed SSH config upsert replaces only the matching host block', () => {
  const first = upsertManagedHostBlock('Host user-host\n  HostName example.com\n', 'odc-app-abc123', {
    dockerPath: '/usr/bin/docker',
    containerId: 'abc',
    identityFile: '/tmp/key file',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/open-dev-container/sshd_config'
  });
  const second = upsertManagedHostBlock(first, 'odc-app-abc123', {
    dockerPath: '/usr/bin/docker',
    containerId: 'def',
    identityFile: '/tmp/key file',
    remoteUser: 'root',
    sshdPath: '/usr/sbin/sshd',
    containerSshdConfig: '/tmp/open-dev-container/sshd_config'
  });

  assert.match(second, /Host user-host/);
  assert.equal((second.match(/# >>> open-dev-container odc-app-abc123/g) || []).length, 1);
  assert.match(second, /ProxyCommand \/usr\/bin\/docker exec -i -u 0 def/);
});

test('removeMarkedBlock and removeAllMarkedBlocks preserve unmanaged SSH config', () => {
  const content = [
    'Host keep',
    '  HostName keep.example',
    '# >>> open-dev-container one',
    'Host one',
    '# <<< open-dev-container one',
    '# >>> open-dev-container two',
    'Host two',
    '# <<< open-dev-container two'
  ].join('\n');

  const oneRemoved = removeMarkedBlock(content, '# >>> open-dev-container one', '# <<< open-dev-container one');
  assert.match(oneRemoved, /Host keep/);
  assert.doesNotMatch(oneRemoved, /Host one/);
  assert.match(oneRemoved, /Host two/);

  const allRemoved = removeAllMarkedBlocks(content);
  assert.equal(allRemoved.removed, 2);
  assert.match(allRemoved.content, /Host keep/);
  assert.doesNotMatch(allRemoved.content, /Host one|Host two/);
});

test('quoteSshConfigValue quotes values that need escaping', () => {
  assert.equal(quoteSshConfigValue('/usr/bin/docker'), '/usr/bin/docker');
  assert.equal(quoteSshConfigValue('/tmp/key file'), '"/tmp/key file"');
  assert.equal(quoteSshConfigValue('/tmp/key"$`'), '"/tmp/key\\"\\$\\`"');
});

test('resolveWorkspaceFolder maps local workspace through bind mounts', () => {
  const inspect = {
    Id: 'abc',
    Config: { WorkingDir: '/fallback' },
    Mounts: [
      { Type: 'volume', Source: 'named', Destination: '/ignored' },
      { Type: 'bind', Source: '/home/user/project', Destination: '/workspace' }
    ]
  };

  assert.equal(resolveWorkspaceFolder(inspect, '/home/user/project/packages/app'), '/workspace/packages/app');
  assert.equal(resolveWorkspaceFolder(inspect, '/home/user/other'), '/fallback');
  assert.equal(resolveWorkspaceFolder({ Id: 'abc', Mounts: [] }), '/');
});

test('utility helpers normalize host aliases, users, and mount summaries', () => {
  assert.equal(createHostAlias({ Names: '/My App!!', ID: '1234567890abcdef' }), 'odc-my-app-123456');
  assert.equal(ensureSafeRemoteUser('dev.user_1'), 'dev.user_1');
  assert.throws(
    () => ensureSafeRemoteUser('bad user'),
    (error) => error instanceof OpenDevContainerError && error.code === 'INVALID_REMOTE_USER'
  );
  assert.equal(summarizeMounts([]), 'none');
});

test('RecentConnectionStore filters invalid records, sorts, deduplicates, and removes', async () => {
  const validOlder = makeRecent({ connectionKey: 'older', lastAttachedAt: 1 });
  const validNewer = makeRecent({ connectionKey: 'newer', lastAttachedAt: 2 });
  const storage = new MemoryStorage([validOlder, { connectionKey: 'broken' }, validNewer]);
  const store = new RecentConnectionStore(storage);

  assert.deepEqual((await store.getAll()).map((item) => item.connectionKey), ['newer', 'older']);
  assert.equal(sanitizeRecentConnection({ connectionKey: 'broken' }), undefined);

  await store.save(makeRecent({ connectionKey: 'older', lastAttachedAt: 3, workspaceFolder: '/new' }));
  assert.deepEqual((await store.getAll()).map((item) => item.connectionKey), ['older', 'newer']);
  assert.equal((await store.getMostRecent()).workspaceFolder, '/new');

  assert.equal(await store.remove('older'), true);
  assert.equal(await store.remove('missing'), false);
  assert.deepEqual((await store.getAll()).map((item) => item.connectionKey), ['newer']);
});

test('buildPrepareSshdScript includes install and no-install failure paths', () => {
  assert.match(buildPrepareSshdScript('root', 'ssh-ed25519 AAA test', true), /apt-get install -y openssh-server/);
  assert.match(buildPrepareSshdScript('root', 'ssh-ed25519 AAA test', true), /pacman -Sy --noconfirm openssh/);
  assert.match(buildPrepareSshdScript('root', 'ssh-ed25519 AAA test', false), /OPEN_DEV_CONTAINER_ERROR=MISSING_SSHD/);
});

function makeRecent(overrides = {}) {
  return {
    connectionKey: 'key',
    containerId: 'abc',
    containerName: 'app',
    image: 'node',
    hostAlias: 'odc-app-abc123',
    workspaceFolder: '/workspace',
    dockerPath: 'docker',
    remoteUser: 'root',
    sshConfigPath: '/home/user/.ssh/config',
    lastAttachedAt: 1,
    lastStatus: 'Up',
    workingDir: '/workspace',
    mountSummary: 'none',
    ...overrides
  };
}

class MemoryStorage {
  constructor(initial) {
    this.value = initial;
  }

  get() {
    return this.value;
  }

  async update(_key, value) {
    this.value = value;
  }
}

test('buildPrepareSshdScript force command exits with the command instead of lingering', () => {
  const script = buildPrepareSshdScript('root', 'ssh-ed25519 AAAA test', false);
  const forceCommand = script.match(/<<'EOF'\n([\s\S]*?)\nEOF/)[1];
  // open-remote-ssh resolves exec() only when the channel closes; a lingering
  // session (the old `while :; do sleep 3600; done`) hangs the connection.
  assert.doesNotMatch(forceCommand, /sleep 3600/);
  assert.match(forceCommand, /exec "\$\{SHELL:-\/bin\/sh\}" -c "\$CMD"/);
  assert.doesNotMatch(forceCommand, /-lc/);
  // Strips the login shell from open-remote-ssh's "... | bash -l" server install
  // so hostile container profile/rc files cannot swallow the piped script.
  assert.match(forceCommand, /\| bash -l"\)\s+CMD="\$\{CMD%\| bash -l\}\| bash"/);
});
