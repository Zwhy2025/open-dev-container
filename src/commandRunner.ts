import { execFile } from 'node:child_process';
import { OpenDevContainerError, formatErrorDetail } from './errors';
import type { ExecResult } from './types';

function isContainerCli(file: string): boolean {
  return /(^|[\\/])(docker|podman)(\.exe)?$/i.test(file);
}

export async function execFileAsync(
  file: string,
  args: string[],
  options: { maxBuffer?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: options.maxBuffer ?? 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(normalizeCommandError(file, args, error, stdout, stderr));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export function normalizeCommandError(
  file: string,
  args: string[],
  error: Error & { code?: string | number | null },
  stdout: string,
  stderr: string
): OpenDevContainerError {
  const combined = [stderr.trim(), stdout.trim(), error.message].filter(Boolean).join('\n').trim();

  if (error.code === 'ENOENT') {
    if (isContainerCli(file)) {
      return new OpenDevContainerError(
        'DOCKER_CLI_MISSING',
        `${file} was not found. Configure \`openDevContainer.dockerPath\` or install Podman/Docker.`,
        combined
      );
    }

    if (file === 'ssh-keygen') {
      return new OpenDevContainerError(
        'SSH_KEYGEN_MISSING',
        'ssh-keygen was not found on the host. Install OpenSSH client tools.',
        combined
      );
    }
  }

  if (isContainerCli(file)) {
    if (/cannot connect to the Docker daemon|permission denied while trying to connect to the Docker daemon|is the docker daemon running|error during connect|cannot connect to podman|unable to connect to podman socket|podman.sock/i.test(combined)) {
      return new OpenDevContainerError(
        'DOCKER_DAEMON_UNAVAILABLE',
        'The container engine is not reachable or the current user cannot access it.',
        combined,
        typeof error.code === 'number' ? error.code : undefined
      );
    }

    if (/permission denied|operation not permitted/i.test(combined) && /docker|podman/i.test(combined)) {
      return new OpenDevContainerError(
        'DOCKER_PERMISSION_DENIED',
        'The container engine denied the requested operation. Check socket permissions, rootless mode, or container policy.',
        combined,
        typeof error.code === 'number' ? error.code : undefined
      );
    }

    if (/no such container/i.test(combined)) {
      return new OpenDevContainerError('CONTAINER_NOT_FOUND', 'The selected container no longer exists.', combined);
    }

    if (/exec: "sh": executable file not found in \$PATH|sh: not found|executable file not found/i.test(combined)) {
      return new OpenDevContainerError(
        'CONTAINER_SHELL_MISSING',
        'The container does not provide `/bin/sh`.',
        combined
      );
    }
  }

  return new OpenDevContainerError(
    'DOCKER_EXEC_FAILED',
    `Command failed: ${file} ${args.join(' ')}`,
    combined,
    typeof error.code === 'number' ? error.code : undefined
  );
}

export function classifyDockerCommandError(error: unknown, file: string, args: string[]): OpenDevContainerError {
  if (error instanceof OpenDevContainerError) {
    return error;
  }

  if (error instanceof Error) {
    return normalizeCommandError(
      file,
      args,
      Object.assign(new Error(error.message), { code: (error as NodeJS.ErrnoException).code }) as NodeJS.ErrnoException,
      '',
      formatErrorDetail(error) || ''
    );
  }

  return new OpenDevContainerError('DOCKER_EXEC_FAILED', String(error));
}

export function classifyHostCommandError(error: unknown, file: string): OpenDevContainerError {
  if (error instanceof OpenDevContainerError) {
    return error;
  }

  if (error instanceof Error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new OpenDevContainerError(
        file === 'ssh-keygen' ? 'SSH_KEYGEN_MISSING' : 'UNKNOWN',
        `${file} was not found on the host.`,
        error.message
      );
    }

    return new OpenDevContainerError('UNKNOWN', error.message, error.stack);
  }

  return new OpenDevContainerError('UNKNOWN', String(error));
}
