const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const compiled = require.resolve('../out/containerPanel.js');
const localRequire = createRequire(compiled);
const exportsObject = {};
vm.runInNewContext(fs.readFileSync(compiled, 'utf8'), {
  exports: exportsObject,
  require: (name) => name === 'vscode' ? { Uri: { joinPath: (...parts) => parts.join('/') } } : localRequire(name)
});
const { ContainerPanelProvider } = exportsObject;

function setup(overrides = {}) {
  const messages = [];
  const calls = [];
  const root = { label: 'Running Containers', actions: [], expandable: true };
  const container = { label: 'app', actions: ['attach'], expandable: true };
  const runtime = { cli: 'docker', availableIds: ['docker', 'podman'], detecting: false };
  const source = {
    runtime: () => runtime,
    children: async (item) => !item ? [root] : item === root ? [container] : [],
    describe: (item) => ({ description: '', tooltip: '', icon: 'container', ...item }),
    action: async (action, item) => calls.push([action, item]),
    switchRuntime: async (id) => { runtime.cli = id; },
    refreshRuntimes: async () => {},
    reportError: async (error) => calls.push(['error', error]),
    ...overrides
  };
  const provider = new ContainerPanelProvider('/extension', source);
  provider.resolveWebviewView({ webview: {
    cspSource: 'self', asWebviewUri: (uri) => uri,
    onDidReceiveMessage: () => ({ dispose() {} }),
    postMessage: async (message) => messages.push(message)
  }, onDidDispose() {}, onDidChangeVisibility() {} });
  return { provider, messages, calls, runtime, container, source };
}
const lastGroups = (s) => s.messages.filter((m) => m.type === 'groups').at(-1).groups;

test('panel only allows supported actions on items in the current list', async () => {
  const s = setup();
  await s.provider.receive({ type: 'ready' });
  const id = lastGroups(s)[0].children[0].id;
  for (const message of [null, { type: 'action', id: 'forged', action: 'attach' },
    { type: 'action', id, action: 'clean' }, { type: 'switch', id: 'unknown' }]) await s.provider.receive(message);
  assert.equal(s.calls.length, 0);
  await s.provider.receive({ type: 'action', id, action: 'attach' });
  assert.equal(s.calls[0][1], s.container);
  await s.provider.receive({ type: 'action', id, action: 'attach' });
  assert.equal(s.calls.length, 1);
});

test('panel restores selection and unlocks after a cancelled or failed switch', async () => {
  for (const failed of [false, true]) {
    const s = setup({ switchRuntime: async () => { if (failed) throw new Error('unavailable'); } });
    await s.provider.refresh();
    await s.provider.receive({ type: 'switch', id: 'podman' });
    const status = s.messages.at(-1);
    assert.equal(status.runtime.activeId, 'docker');
    assert.equal(status.busy, false);
    assert.equal(status.loading, false);
    assert.equal(s.calls.length, failed ? 1 : 0);
  }
});

test('panel ignores a superseded list response and actions while loading', async () => {
  const s = setup();
  let finish;
  const original = s.source.children;
  s.source.children = (item) => !item ? new Promise((resolve) => { finish = resolve; }) : original(item);
  const old = s.provider.refresh();
  await s.provider.receive({ type: 'cleanAll' });
  assert.equal(s.calls.length, 0);
  s.source.children = original;
  await s.provider.refresh();
  const count = s.messages.filter((m) => m.type === 'groups').length;
  finish([]);
  await old;
  assert.equal(s.messages.filter((m) => m.type === 'groups').length, count);
});

test('panel blocks concurrent operations and switches the displayed engine', async () => {
  let finish;
  const s = setup();
  s.source.switchRuntime = async (id) => { await new Promise((resolve) => { finish = resolve; }); s.runtime.cli = id; };
  await s.provider.refresh();
  const switching = s.provider.receive({ type: 'switch', id: 'podman' });
  await s.provider.receive({ type: 'cleanAll' });
  assert.equal(s.calls.length, 0);
  finish(); await switching;
  assert.equal(s.messages.at(-1).runtime.activeId, 'podman');
});

test('panel routes recent connection actions using host records', async () => {
  for (const action of ['reconnect', 'disconnect', 'clean']) {
    const recent = { label: 'saved app', actions: ['reconnect', 'disconnect', 'clean'], expandable: false };
    const root = { label: 'Recent Connections', actions: [], expandable: true };
    const s = setup({ children: async (item) => !item ? [root] : [recent] });
    await s.provider.refresh();
    await s.provider.receive({ type: 'action', id: lastGroups(s)[0].children[0].id, action, connection: { sshConfigPath: '/untrusted' } });
    assert.equal(s.calls[0][0], action);
    assert.equal(s.calls[0][1], recent);
  }
});

test('panel discards container details requested before an engine change', async () => {
  const s = setup();
  await s.provider.refresh();
  let finish;
  const original = s.source.children;
  s.source.children = (item) => item === s.container ? new Promise((resolve) => { finish = resolve; }) : original(item);
  const request = s.provider.receive({ type: 'expand', id: lastGroups(s)[0].children[0].id });
  await s.provider.receive({ type: 'switch', id: 'podman' });
  finish([{ label: 'Old details', expandable: false, actions: [] }]);
  await request;
  assert.equal(s.messages.some((message) => message.type === 'children'), false);
});
