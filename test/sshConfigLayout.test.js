const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureManagedConfigLayout, extractManagedBlocks, hasIncludeDirective } = require('../out/sshConfig.js');

test('extractManagedBlocks splits managed blocks away from the user config', () => {
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

  const { content: rest, blocks } = extractManagedBlocks(content);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /Host one/);
  assert.match(rest, /Host keep/);
  assert.doesNotMatch(rest, /Host one|Host two/);
});

test('hasIncludeDirective only reports the include line that is already present', () => {
  assert.equal(hasIncludeDirective('Include ~/.ssh/config.d/odc.conf\n', '~/.ssh/config.d/odc.conf'), true);
  assert.equal(hasIncludeDirective('Include ~/.ssh/config.d/other.conf\n', '~/.ssh/config.d/odc.conf'), false);
  assert.equal(hasIncludeDirective('Host keep\n', '~/.ssh/config.d/odc.conf'), false);
});

test('ensureManagedConfigLayout moves blocks out, adds the include line, and is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-config-'));
  const main = path.join(dir, 'config');
  const managed = path.join(dir, 'config.d', 'open-dev-container.conf');

  fs.writeFileSync(
    main,
    [
      'Host keep',
      '  HostName keep.example',
      '# >>> open-dev-container one',
      'Host one',
      '# <<< open-dev-container one'
    ].join('\n') + '\n',
    { mode: 0o600 }
  );

  try {
    const first = await ensureManagedConfigLayout(main, managed);
    assert.deepEqual(first, { includeAdded: true, migrated: 1 });

    const mainContent = fs.readFileSync(main, 'utf8');
    assert.match(mainContent, /^Include /);
    assert.match(mainContent, /Host keep/);
    assert.doesNotMatch(mainContent, /Host one/);
    assert.match(fs.readFileSync(managed, 'utf8'), /Host one/);

    const second = await ensureManagedConfigLayout(main, managed);
    assert.deepEqual(second, { includeAdded: false, migrated: 0 });
    assert.equal(fs.readFileSync(main, 'utf8'), mainContent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureManagedConfigLayout leaves a config that only holds user hosts alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-config-'));
  const main = path.join(dir, 'config');
  const managed = path.join(dir, 'config.d', 'open-dev-container.conf');

  fs.writeFileSync(main, 'Host keep\n  HostName keep.example\n', { mode: 0o600 });

  try {
    const result = await ensureManagedConfigLayout(main, managed);
    assert.deepEqual(result, { includeAdded: true, migrated: 0 });
    assert.match(fs.readFileSync(main, 'utf8'), /Host keep/);
    assert.equal(fs.existsSync(managed), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
