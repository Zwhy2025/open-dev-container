const assert = require('node:assert/strict');
const test = require('node:test');
const { getContainerState, getContainerStatus, getContainerActions, resolveContainerShell } = require('../out/containerState');
const { DockerClient } = require('../out/dockerClient');

test('container actions reflect Docker and Podman lifecycle states', () => {
  for (const [state, actions] of Object.entries({ running: ['attach', 'shell', 'stop', 'restart', 'remove'], restarting: ['stop', 'remove'],
    exited: ['start', 'remove'], stopped: ['start', 'remove'], created: ['start', 'remove'], configured: ['start', 'remove'],
    paused: ['stop', 'restart', 'remove'], removing: ['remove'], dead: ['remove'], unknown: ['remove'] })) {
    assert.deepEqual(getContainerActions({ State: state, Status: '' }), actions, state);
  }
  assert.equal(getContainerStatus({ State: 'stopped', Status: '' }).label, 'Stopped');
  assert.equal(getContainerState({ State: '', Status: 'Up 3 minutes (Paused)' }), 'paused');
  assert.equal(getContainerState({ State: '', Status: 'Exited (137) 2 hours ago' }), 'exited');
  assert.equal(getContainerState({ State: '', Status: 'Up 3 minutes' }), 'running');
});

test('container shell setting uses bash by default and preserves a configured command', () => {
  assert.equal(resolveContainerShell(''), 'bash');
  assert.equal(resolveContainerShell('  '), 'bash');
  assert.equal(resolveContainerShell('/bin/bash'), '/bin/bash');
  assert.equal(resolveContainerShell('zsh'), 'zsh');
});

test('container client lists stopped containers and invokes start/stop on the selected engine', async () => {
  for (const cli of ['docker', '/usr/bin/podman']) {
    const calls = [];
    const client = new DockerClient({ dockerPath: cli, run: async (file, args) => {
      calls.push([file, args]);
      return { stdout: args[0] === 'ps' ? '{"ID":"abc","State":"exited","Status":"Exited (0)"}' : '', stderr: '' };
    } });
    assert.equal((await client.listAllContainers())[0].State, 'exited');
    await client.startContainer('abc');
    await client.stopContainer('abc');
    assert.deepEqual(calls, [[cli, ['ps', '-a', '--format', '{{json .}}']], [cli, ['start', 'abc']], [cli, ['stop', 'abc']]]);

    await client.restartContainer('abc');
    await client.removeContainer('abc');
    assert.deepEqual(calls.slice(-2), [[cli, ['restart', 'abc']], [cli, ['rm', '-f', 'abc']]]);
  }
});

test('container lifecycle command failures propagate to the caller', async () => {
  const failure = new Error('daemon unavailable');
  const client = new DockerClient({ dockerPath: 'docker', run: async () => { throw failure; } });
  await assert.rejects(client.startContainer('abc'), failure);
  await assert.rejects(client.stopContainer('abc'), failure);
});
