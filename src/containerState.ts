import type { DockerContainer } from './types';

export type ContainerAction = 'attach' | 'shell' | 'start' | 'stop' | 'restart' | 'remove';

export function resolveContainerShell(value: string): string {
  const shell = value.trim();
  return shell || 'bash';
}

export function getContainerState(container: DockerContainer): string {
  const state = container.State.trim().toLowerCase();
  if (state === 'configured') return 'created';
  if (state === 'stopped') return 'exited';
  if (state) return state;
  if (/paused/i.test(container.Status)) return 'paused';
  if (/^up\b/i.test(container.Status)) return 'running';
  if (/^exited\b/i.test(container.Status)) return 'exited';
  if (/^created\b/i.test(container.Status)) return 'created';
  if (/^restarting\b/i.test(container.Status)) return 'restarting';
  return 'unknown';
}

export function getContainerActions(container: DockerContainer): ContainerAction[] {
  switch (getContainerState(container)) {
    case 'running': return ['attach', 'shell', 'stop', 'restart', 'remove'];
    case 'restarting': return ['stop', 'remove'];
    case 'created':
    case 'exited': return ['start', 'remove'];
    case 'paused': return ['stop', 'restart', 'remove'];
    default: return ['remove'];
  }
}

export function getContainerStatus(container: DockerContainer): { state: string; label: string } {
  const state = getContainerState(container);
  const labels: Record<string, string> = {
    running: 'Running', exited: 'Stopped', created: 'Created', paused: 'Paused',
    restarting: 'Restarting', removing: 'Removing', stopping: 'Stopping', dead: 'Dead', unknown: 'Unknown'
  };
  return { state, label: labels[state] || state };
}
