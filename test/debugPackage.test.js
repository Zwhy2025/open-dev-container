const assert = require('node:assert/strict');
const test = require('node:test');
const { debugManifest } = require('../scripts/package-debug');

test('debug packages carry unique build IDs without changing source metadata', () => {
  const original = { name: 'open-dev-container', displayName: 'Open Dev Container', version: '0.0.4', publisher: 'Zwhy2025' };
  const first = debugManifest(original, undefined, 1788880000000);
  const second = debugManifest(original, undefined, 1788880000001);
  assert.notEqual(first.openDevContainerBuild.id, second.openDevContainerBuild.id);
  assert.notEqual(first.version, second.version);
  assert.equal(first.openDevContainerBuild.baseVersion, '0.0.4');
  assert.equal(original.version, '0.0.4');
  assert.equal(original.openDevContainerBuild, undefined);
  assert.equal(first.name, original.name);
  assert.match(first.displayName, /Debug/);
});
