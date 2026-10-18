const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function debugManifest(manifest, id = randomUUID(), now = Date.now()) {
  return {
    ...manifest,
    version: `0.0.${now}`,
    displayName: `${manifest.displayName} [Debug ${id.slice(0, 8)}]`,
    openDevContainerBuild: { mode: 'debug', id, baseVersion: manifest.version, builtAt: new Date(now).toISOString() }
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = debugManifest(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')));
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'odc-debug-'));
  try {
    for (const file of ['out', 'resources', 'docs', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
      await fs.cp(path.join(root, file), path.join(staging, file), { recursive: true });
    }
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    const output = path.join(root, 'dist', `${manifest.name}-${manifest.openDevContainerBuild.baseVersion}-debug-${manifest.openDevContainerBuild.id}.vsix`);
    execFileSync(path.join(root, 'node_modules', '.bin', 'vsce'), [
      'package', '--no-dependencies', '--allow-missing-repository', '--pre-release', '--out', output
    ], { cwd: staging, stdio: 'inherit' });
    console.log(`Debug build: ${manifest.openDevContainerBuild.id}\nInternal version: ${manifest.version}\nBase version: ${manifest.openDevContainerBuild.baseVersion}`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { debugManifest };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
