import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { OpenDevContainerError } from './errors';
import { shellQuote } from './shell';

export type SshPasswordPrompt = (sshTarget: string) => Promise<string | undefined>;

let storageDir: string | undefined;
let promptPassword: SshPasswordPrompt | undefined;

// Wired up on activation with the extension's global storage and an input-box
// callback, so the pure node modules below it never depend on vscode.
export function configureSshAuth(dir: string, prompt: SshPasswordPrompt): void {
  storageDir = dir;
  promptPassword = prompt;
}

export function getSshPasswordPrompt(): SshPasswordPrompt | undefined {
  return promptPassword;
}

function targetKey(sshTarget: string): string {
  return createHash('sha256').update(sshTarget).digest('hex').slice(0, 16);
}

function passwordFile(sshTarget: string): string {
  return path.join(storageDir as string, `password-${targetKey(sshTarget)}`);
}

function askpassScriptFile(sshTarget: string): string {
  return path.join(storageDir as string, `askpass-${targetKey(sshTarget)}.sh`);
}

// The password never travels on a command line: ssh reads it through an
// SSH_ASKPASS script that cats a 0600 file, so it is invisible in the process
// list of the host.
export async function saveSshPassword(sshTarget: string, password: string): Promise<void> {
  if (!storageDir) {
    throw new OpenDevContainerError('UNKNOWN', 'SSH password storage is not configured.');
  }

  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  const passwordPath = passwordFile(sshTarget);
  await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
  await writeFile(
    askpassScriptFile(sshTarget),
    ['#!/bin/sh', `cat ${shellQuote(passwordPath)}`, ''].join('\n'),
    { mode: 0o700 }
  );
}

export async function forgetSshPassword(sshTarget: string): Promise<void> {
  if (!storageDir) {
    return;
  }

  await rm(passwordFile(sshTarget), { force: true });
  await rm(askpassScriptFile(sshTarget), { force: true });
}

export async function hasSshPassword(sshTarget?: string): Promise<boolean> {
  if (!storageDir || !sshTarget) {
    return false;
  }

  try {
    await access(passwordFile(sshTarget));
    return true;
  } catch {
    return false;
  }
}

// Environment for local `ssh` runs so a password-protected host can be used
// without a terminal to type into.  Requires OpenSSH 8.4+ for
// SSH_ASKPASS_REQUIRE, which stock macOS and current Linux distros ship.
export async function getSshAskpassEnv(sshTarget: string): Promise<NodeJS.ProcessEnv | undefined> {
  if (!(await hasSshPassword(sshTarget))) {
    return undefined;
  }

  return {
    SSH_ASKPASS: askpassScriptFile(sshTarget),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: ':0'
  };
}

// Path of the askpass script when a password is stored, for embedding into the
// ProxyCommand line of a managed SSH config block.
export async function getSshAskpassScript(sshTarget?: string): Promise<string | undefined> {
  if (!(await hasSshPassword(sshTarget))) {
    return undefined;
  }

  return askpassScriptFile(sshTarget as string);
}

// ssh exits 255 for its own failures while remote commands propagate the
// remote exit status, so the exit code keeps daemon errors from being mistaken
// for authentication problems.
export function isSshAuthFailure(error: unknown): boolean {
  if (!(error instanceof OpenDevContainerError) || error.exitCode !== 255) {
    return false;
  }

  return /permission denied|password/i.test(`${error.message}\n${error.detail || ''}`);
}
