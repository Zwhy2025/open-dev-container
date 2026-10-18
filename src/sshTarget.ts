import { Buffer } from 'node:buffer';
import { splitShellWords } from './shell';

export const SSH_REMOTE_AUTHORITY_PREFIX = 'ssh-remote+';

export type SshTargetSource = 'setting' | 'workspace-authority' | 'container-host' | 'none';

export type SshResolution = {
  target?: string;
  source: SshTargetSource;
};

// `vscode.env.remoteName` is `ssh-remote` for SSH remotes.  It is readable from
// the local extension host too, which is what lets a UI-side extension detect
// that the window is attached to a remote machine.
export function isSshRemote(remoteName: string | null | undefined): boolean {
  const value = (remoteName || '').toLowerCase();
  return value === 'ssh-remote' || value === 'ssh';
}

// VS Code encodes the SSH host it is connected to into the authority of remote
// workspace folders, for example `vscode-remote://ssh-remote+build-01/srv/app`.
export function parseSshTargetFromAuthority(authority: string): string | undefined {
  const trimmed = authority.trim();
  if (!trimmed.toLowerCase().startsWith(SSH_REMOTE_AUTHORITY_PREFIX)) {
    return undefined;
  }

  let encoded = trimmed.slice(SSH_REMOTE_AUTHORITY_PREFIX.length).trim();
  if (!encoded) {
    return undefined;
  }

  // Remote SSH appends a `+<hex>` suffix when several connections share the
  // same host name, so strip it before looking the alias up in SSH config.
  const separator = encoded.lastIndexOf('+');
  if (separator > 0 && /^[0-9a-f]{8,}$/i.test(encoded.slice(separator + 1))) {
    encoded = encoded.slice(0, separator);
  }

  if (!encoded) {
    return undefined;
  }

  // Trae's Remote SSH encodes direct connections (entered as `user@host`,
  // not an ssh config alias) as hex-encoded JSON, for example
  // `ssh-remote+7b22686f73744e616d65...` -> `{"hostName":"192.0.2.10",...}`.
  const connection = parseEncodedConnection(decodeHexAuthority(encoded));
  if (connection) {
    return connection;
  }

  try {
    return decodeURIComponent(encoded) || undefined;
  } catch {
    return encoded;
  }
}

// Returns the hex-decoded text when `value` looks like a hex-encoded payload;
// real aliases are too short and almost always contain non-hex characters.
function decodeHexAuthority(value: string): string | undefined {
  if (value.length < 20 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return undefined;
  }
  return Buffer.from(value, 'hex').toString('utf8');
}

// Recovers the ssh destination from Trae's encoded connection JSON so the
// container CLI can be forwarded to that host with plain `ssh`.
function parseEncodedConnection(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const hostName = typeof record.hostName === 'string' ? record.hostName.trim() : '';
  if (!hostName) {
    return undefined;
  }

  const username = [record.username, record.user].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const user = username?.trim();
  const port = typeof record.port === 'number' ? String(record.port) : typeof record.port === 'string' ? record.port.trim() : '';
  const destination = user ? `${user}@${hostName}` : hostName;

  // OpenSSH accepts `ssh://user@host:port` as a destination, which lets the
  // non-default port travel inside the single sshTarget string.
  return port && port !== '22' ? `ssh://${destination}:${port}` : destination;
}

// Resolution order: explicit `openDevContainer.remoteHost` setting > the SSH
// host of the current remote window > local execution.
export function resolveSshTarget(input: {
  configuredHost?: string;
  remoteName?: string | null;
  authority?: string;
}): SshResolution {
  const configured = (input.configuredHost || '').trim();
  if (configured) {
    return { target: configured, source: 'setting' };
  }

  if (!isSshRemote(input.remoteName)) {
    return { source: 'none' };
  }

  const target = input.authority ? parseSshTargetFromAuthority(input.authority) : undefined;
  return target ? { target, source: 'workspace-authority' } : { source: 'none' };
}

// A window opened *inside* a container reports the container's own ssh alias as
// its authority, because that alias is what Remote SSH connected through.  The
// container CLI does not live in there, so asking that alias for `docker ps`
// looks for a container inside the container and finds nothing.
//
// The managed block written by this extension records the real host one level
// up in its ProxyCommand, so recovering it turns "Remote · <container alias>"
// into "Remote · <host that runs the container>".  Blocks written for a purely
// local container have no ssh hop, which is exactly the case that must stay
// unresolved.
export function parseManagedHostTarget(content: string, hostAlias: string): string | undefined {
  const block = extractManagedBlock(content, hostAlias);
  if (!block) {
    return undefined;
  }

  const proxyLine = block.split(/\r?\n/).find((line) => /^\s*ProxyCommand\s+/.test(line));
  if (!proxyLine) {
    return undefined;
  }

  const words = splitShellWords(proxyLine.replace(/^\s*ProxyCommand\s+/, ''));
  const sshIndex = words.indexOf('ssh');
  if (sshIndex < 0 || sshIndex + 1 >= words.length) {
    return undefined;
  }

  const target = words[sshIndex + 1].trim();
  return target && target !== hostAlias ? target : undefined;
}

function extractManagedBlock(content: string, hostAlias: string): string | undefined {
  const begin = `# >>> open-dev-container ${hostAlias}`;
  const end = `# <<< open-dev-container ${hostAlias}`;
  const start = content.indexOf(begin);
  if (start < 0) {
    return undefined;
  }

  const stop = content.indexOf(end, start);
  if (stop < 0) {
    return undefined;
  }

  return content.slice(start + begin.length, stop);
}
