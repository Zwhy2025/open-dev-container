import { execFileAsync, normalizeCommandError, type ExecOptions } from './commandRunner';
import { CONTAINER_RUNTIMES, type ContainerRuntime } from './containerRuntimes';
import { OpenDevContainerError } from './errors';
import { shellQuote } from './shell';
import { forgetSshPassword, getSshAskpassEnv, getSshPasswordPrompt, isSshAuthFailure, saveSshPassword } from './sshAuth';
import type { ExecResult } from './types';

export type ExecFn = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export function buildSshInvocation(sshTarget: string, cli: string, args: string[]): { file: string; args: string[] } {
  // accept-new trusts unseen hosts on first use instead of blocking on the
  // yes/no prompt, which no terminal is around to answer here.  The managed
  // config blocks use `no` instead: their host is a container sshd whose key
  // legitimately changes when the container is recreated.
  return {
    file: 'ssh',
    args: ['-o', 'StrictHostKeyChecking=accept-new', sshTarget, [cli, ...args].map(shellQuote).join(' ')]
  };
}

// Runs a container CLI locally, or forwards it to a Remote SSH host.  Keeping
// this in one place means listing, inspecting, lifecycle actions and sshd
// provisioning all honour the same execution target.
export async function execContainerCli(
  cli: string,
  args: string[],
  sshTarget: string | undefined,
  options: ExecOptions = {},
  run: ExecFn = execFileAsync
): Promise<ExecResult> {
  if (!sshTarget) {
    return run(cli, args, options);
  }

  const invocation = buildSshInvocation(sshTarget, cli, args);

  try {
    return await runSshCommand(invocation, sshTarget, options, run);
  } catch (error: unknown) {
    const prompt = getSshPasswordPrompt();
    if (!isSshAuthFailure(error) || !prompt) {
      // ssh hides which engine failed, so re-run the classifier against the
      // CLI that actually executed on the remote host.
      throw reclassifyRemoteFailure(error, cli, args);
    }

    // A stored password is stale (or none was saved yet): drop it, ask the
    // user, and retry exactly once before giving up.
    await forgetSshPassword(sshTarget);
    const password = await prompt(sshTarget);
    if (!password) {
      throw reclassifyRemoteFailure(error, cli, args);
    }

    await saveSshPassword(sshTarget, password);
    try {
      return await runSshCommand(invocation, sshTarget, options, run);
    } catch (retryError: unknown) {
      throw reclassifyRemoteFailure(retryError, cli, args);
    }
  }
}

async function runSshCommand(
  invocation: { file: string; args: string[] },
  sshTarget: string,
  options: ExecOptions,
  run: ExecFn
): Promise<ExecResult> {
  const askpassEnv = await getSshAskpassEnv(sshTarget);
  const execOptions: ExecOptions = askpassEnv ? { ...options, env: { ...process.env, ...askpassEnv } } : options;
  return run(invocation.file, invocation.args, execOptions);
}

function reclassifyRemoteFailure(error: unknown, cli: string, args: string[]): unknown {
  if (!(error instanceof OpenDevContainerError)) {
    return error;
  }

  const detail = error.detail || '';
  const synthetic = Object.assign(new Error(error.message), { code: error.exitCode }) as Error & {
    code?: string | number | null;
  };

  return normalizeCommandError(cli, args, synthetic, '', detail);
}

// Probes each registered CLI with `--version` so the switcher only offers
// runtimes that really exist on the active host.
export async function detectAvailableRuntimes(sshTarget?: string): Promise<ContainerRuntime[]> {
  const checks = CONTAINER_RUNTIMES.map(async (runtime) => {
    const available = await execContainerCli(runtime.cli, ['--version'], sshTarget).then(
      () => true,
      () => false
    );
    return available ? runtime : undefined;
  });

  return (await Promise.all(checks)).filter((runtime): runtime is ContainerRuntime => Boolean(runtime));
}
