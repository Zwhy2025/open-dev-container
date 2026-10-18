import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { OpenDevContainerError, formatErrorDetail } from './errors';
import { readFileIfExists, writeFileAtomic } from './fileSystem';
import { shellQuote } from './shell';
import { escapeRegExp } from './utils';

export const SSH_CONFIG_BEGIN = '# >>> open-dev-container';
export const SSH_CONFIG_END = '# <<< open-dev-container';

// Blocks the extension writes live in this dedicated file so the user's own
// ~/.ssh/config only ever gains a single Include line.
export const MANAGED_CONFIG_PATH = '~/.ssh/config.d/open-dev-container.conf';

export type SshConfigOptions = {
  dockerPath: string;
  containerId: string;
  identityFile: string;
  remoteUser: string;
  sshdPath: string;
  containerSshdConfig: string;
  sshTarget?: string;
  askpassScript?: string;
};

// Locally the container CLI runs directly.  Inside a Remote SSH window the CLI
// lives on that host, so the whole command is forwarded through ssh and the
// local ssh client reaches the container via the remote host.
//
// ssh runs the line through a shell, so buildProxyCommand returns shell words,
// not ssh_config values; callers just join them with spaces.
export function buildProxyCommand(options: SshConfigOptions): string {
  const dockerCommand = [
    options.dockerPath,
    'exec',
    '-i',
    '-u',
    '0',
    options.containerId,
    options.sshdPath,
    '-i',
    '-f',
    options.containerSshdConfig
  ];

  const dockerInvocation = dockerCommand.map(quoteProxyWord).join(' ');

  if (!options.sshTarget) {
    return dockerInvocation;
  }

  // ssh takes the remote command as one argument, so it stays double quoted:
  // that keeps the single quotes of the container command intact locally and
  // still hands the remote shell a single word.
  const remoteInvocation = quoteSshConfigValue(dockerCommand.map(shellQuote).join(' '));
  const words = ['ssh', quoteProxyWord(options.sshTarget), remoteInvocation];

  // A ProxyCommand has no terminal to answer password prompts in, so hand ssh
  // an SSH_ASKPASS script (see sshAuth.ts) when one was saved for this host.
  if (options.askpassScript) {
    words.unshift('env', shellQuote(`SSH_ASKPASS=${options.askpassScript}`), 'SSH_ASKPASS_REQUIRE=force', 'DISPLAY=:0');
  }

  return words.join(' ');
}

// Quotes one word of the ProxyCommand line for the shell that runs it.  Every
// word is quoted on its own: wrapping several words into one ssh_config value
// makes the shell look for a program literally named "env SSH_ASKPASS=...".
export function quoteProxyWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+,-]+$/.test(value) ? value : shellQuote(value);
}

export async function upsertSshConfig(sshConfigPath: string, hostAlias: string, options: SshConfigOptions): Promise<void> {
  try {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true, mode: 0o700 });
    const current = await readFileIfExists(sshConfigPath);
    const next = upsertManagedHostBlock(current, hostAlias, options);
    await writeFileAtomic(sshConfigPath, next, 0o600);
  } catch (error: unknown) {
    throw new OpenDevContainerError('SSH_CONFIG_WRITE_FAILED', `Failed to update SSH config at ${sshConfigPath}.`, formatErrorDetail(error));
  }
}

export async function removeManagedHostBlockFromFile(sshConfigPath: string, hostAlias: string): Promise<boolean> {
  const current = await readFileIfExists(sshConfigPath);
  const next = removeManagedHostBlock(current, hostAlias);
  if (next === current) {
    return false;
  }

  await writeFileAtomic(sshConfigPath, next, 0o600);
  return true;
}

export async function removeAllManagedBlocksFromFile(sshConfigPath: string): Promise<{ removed: number }> {
  const current = await readFileIfExists(sshConfigPath);
  const result = removeAllMarkedBlocks(current);
  if (result.removed === 0) {
    return result;
  }

  await writeFileAtomic(sshConfigPath, result.content, 0o600);
  return result;
}

export function upsertManagedHostBlock(content: string, hostAlias: string, options: SshConfigOptions): string {
  const begin = `${SSH_CONFIG_BEGIN} ${hostAlias}`;
  const end = `${SSH_CONFIG_END} ${hostAlias}`;
  const withoutExisting = removeMarkedBlock(content, begin, end).trimEnd();
  const block = [
    begin,
    `Host ${hostAlias}`,
    '  HostName 127.0.0.1',
    `  User ${options.remoteUser}`,
    `  IdentityFile ${quoteSshConfigValue(options.identityFile)}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  LogLevel ERROR',
    `  ProxyCommand ${buildProxyCommand(options)}`,
    end,
    ''
  ].join('\n');

  return `${withoutExisting}${withoutExisting ? '\n\n' : ''}${block}`;
}

export function removeManagedHostBlock(content: string, hostAlias: string): string {
  return removeMarkedBlock(content, `${SSH_CONFIG_BEGIN} ${hostAlias}`, `${SSH_CONFIG_END} ${hostAlias}`);
}

export function removeMarkedBlock(content: string, begin: string, end: string): string {
  const escapedBegin = escapeRegExp(begin);
  const escapedEnd = escapeRegExp(end);
  return content.replace(new RegExp(`\\n?${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), '\n');
}

export function removeAllMarkedBlocks(content: string): { content: string; removed: number } {
  const pattern = new RegExp(`(?:\\r?\\n)?${escapeRegExp(SSH_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(SSH_CONFIG_END)}[^\\n]*(?:\\r?\\n)?`, 'g');
  let removed = 0;
  const next = content.replace(pattern, () => {
    removed += 1;
    return '\n';
  });

  return {
    content: next.trimEnd(),
    removed
  };
}

// Pulls the managed blocks out of `content` so they can be moved elsewhere.
export function extractManagedBlocks(content: string): { content: string; blocks: string[] } {
  const blocks: string[] = [];
  const pattern = new RegExp(`(?:\\r?\\n)?${escapeRegExp(SSH_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(SSH_CONFIG_END)}[^\\n]*(?:\\r?\\n)?`, 'g');
  const next = content.replace(pattern, (block) => {
    blocks.push(block.replace(/^\n+|\n+$/g, ''));
    return '\n';
  });

  return { content: next.trimEnd(), blocks };
}

export function hasIncludeDirective(content: string, includePath: string): boolean {
  return new RegExp(`^\\s*Include\\s+${escapeRegExp(includePath)}\\s*$`, 'm').test(content);
}

// Moves blocks that older versions wrote straight into the main config into the
// dedicated file, then makes sure the main config includes that file.  Both
// steps are idempotent, and the main config keeps everything it already owned.
export async function ensureManagedConfigLayout(
  mainConfigPath: string,
  managedConfigPath: string
): Promise<{ includeAdded: boolean; migrated: number }> {
  const mainContent = await readFileIfExists(mainConfigPath);
  const { content, blocks } = extractManagedBlocks(mainContent);

  if (blocks.length > 0) {
    await fs.mkdir(path.dirname(managedConfigPath), { recursive: true, mode: 0o700 });
    const existing = await readFileIfExists(managedConfigPath);
    const prefix = existing.replace(/\s+$/, '');
    await writeFileAtomic(managedConfigPath, `${prefix}${prefix ? '\n' : ''}${blocks.join('\n')}\n`, 0o600);
  }

  let next = content;
  const includeAdded = !hasIncludeDirective(next, managedConfigPath);
  if (includeAdded) {
    next = `Include ${managedConfigPath}\n\n${next.replace(/^\n+/, '')}`;
  }

  if (next !== mainContent) {
    await writeFileAtomic(mainConfigPath, next, 0o600);
  }

  return { includeAdded, migrated: blocks.length };
}

export function parseMarker(output: string, key: string): string | undefined {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

export function quoteSshConfigValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}
