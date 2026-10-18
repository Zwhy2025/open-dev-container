import { execFile } from 'node:child_process';

export type ContainerRuntime = {
  id: string;
  label: string;
  cli: string;
  daemonUnreachable: RegExp;
  permissionDenied: RegExp;
};

// Adding a runtime (e.g. nerdctl) = adding one entry here; listing, error
// classification and the runtime switcher pick it up automatically.
export const CONTAINER_RUNTIMES: ContainerRuntime[] = [
  {
    id: 'docker',
    label: 'Docker',
    cli: 'docker',
    daemonUnreachable:
      /cannot connect to the Docker daemon|permission denied while trying to connect to the Docker daemon|is the docker daemon running|error during connect/i,
    permissionDenied: /permission denied|operation not permitted/i
  },
  {
    id: 'podman',
    label: 'Podman',
    cli: 'podman',
    daemonUnreachable: /cannot connect to podman|unable to connect to podman socket|podman\.sock/i,
    permissionDenied: /permission denied|operation not permitted/i
  }
];

export function findRuntimeByCli(file: string): ContainerRuntime | undefined {
  const base = (file.split(/[\\/]/).pop() || '').replace(/\.exe$/i, '').toLowerCase();
  return CONTAINER_RUNTIMES.find((runtime) => runtime.cli === base);
}

// Resolution order: explicit `openDevContainer.dockerPath` setting > runtime
// picked via the switch command > auto (docker first, then registry order).
export function resolveContainerCli(
  dockerPathSetting: string,
  activeRuntimeId: string | undefined,
  availableRuntimeIds: string[]
): string {
  const explicit = dockerPathSetting.trim();
  if (explicit) {
    return explicit;
  }

  if (activeRuntimeId) {
    const active = CONTAINER_RUNTIMES.find((runtime) => runtime.id === activeRuntimeId);
    if (active) {
      return active.cli;
    }
  }

  const detected = CONTAINER_RUNTIMES.find((runtime) => availableRuntimeIds.includes(runtime.id));
  return (detected || CONTAINER_RUNTIMES[0]).cli;
}

export async function detectAvailableRuntimes(): Promise<ContainerRuntime[]> {
  const checks = CONTAINER_RUNTIMES.map(async (runtime) => {
    const available = await new Promise<boolean>((resolve) => {
      execFile(runtime.cli, ['--version'], (error) => resolve(!error));
    });
    return available ? runtime : undefined;
  });
  return (await Promise.all(checks)).filter((runtime): runtime is ContainerRuntime => Boolean(runtime));
}
