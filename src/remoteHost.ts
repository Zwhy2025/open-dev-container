import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { parseManagedHostTarget, resolveSshTarget } from './sshTarget';
import { MANAGED_CONFIG_PATH } from './sshConfig';
import { expandHome } from './utils';

export type { SshResolution, SshTargetSource } from './sshTarget';
export { SSH_REMOTE_AUTHORITY_PREFIX, isSshRemote, parseSshTargetFromAuthority, resolveSshTarget } from './sshTarget';

// Resolves the host the container CLI has to run on for the active window.
// Empty means the local machine.
export function resolveActiveSshTarget(): ReturnType<typeof resolveSshTarget> {
  const config = vscode.workspace.getConfiguration('openDevContainer');
  const resolved = resolveSshTarget({
    configuredHost: config.get<string>('remoteHost') || '',
    remoteName: vscode.env.remoteName,
    authority: vscode.workspace.workspaceFolders?.[0]?.uri.authority
  });

  const alias = resolved.target;
  if (!alias) {
    return resolved;
  }

  // Inside a container window the authority is the container alias, and the
  // container itself has no container CLI.  Step up to the host recorded in the
  // managed block so the panel lists the containers of the machine that
  // actually runs them.
  const host = parseManagedHostTarget(readManagedConfig(), alias);
  return host ? { target: host, source: 'container-host' } : resolved;
}

// The managed blocks live in their own file (see sshConfig.ts), so reading it
// is cheap and never drags the user's whole ~/.ssh/config into the picture.
// `resolveActiveSshTarget()` still runs several times per panel refresh, so the
// content is cached until the file actually changes.
let cachedConfig: { mtimeMs: number; size: number; content: string } | undefined;

function readManagedConfig(): string {
  const file = expandHome(MANAGED_CONFIG_PATH);
  try {
    const { mtimeMs, size } = fs.statSync(file);
    if (cachedConfig && cachedConfig.mtimeMs === mtimeMs && cachedConfig.size === size) {
      return cachedConfig.content;
    }

    const content = fs.readFileSync(file, 'utf8');
    cachedConfig = { mtimeMs, size, content };
    return content;
  } catch {
    cachedConfig = undefined;
    return '';
  }
}
