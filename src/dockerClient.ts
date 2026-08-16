import { execFileAsync } from './commandRunner';
import { OpenDevContainerError, formatErrorDetail } from './errors';
import type { DockerContainer, DockerInspect } from './types';

export class DockerClient {
  constructor(private readonly dockerPath: string) {}

  async listRunningContainers(): Promise<DockerContainer[]> {
    const { stdout } = await execFileAsync(this.dockerPath, ['ps', '--format', '{{json .}}'], { maxBuffer: 1024 * 1024 });
    return parseDockerContainerList(stdout);
  }

  async inspectContainer(containerId: string): Promise<DockerInspect> {
    const { stdout } = await execFileAsync(this.dockerPath, ['inspect', containerId], { maxBuffer: 10 * 1024 * 1024 });
    return parseDockerInspect(stdout, containerId);
  }
}

export function parseDockerContainerList(stdout: string): DockerContainer[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeContainerRecord(parseContainerLine(line), line));
}

function parseContainerLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new OpenDevContainerError('DOCKER_OUTPUT_PARSE_FAILED', 'Docker returned container output that could not be parsed.', line);
  }
}

// Podman's `{{json .}}` marshals the raw ListContainer struct instead of the accessor methods
// Docker exposes: the id is tagged `Id`, `Names` is an array, and `Status` is left empty.
export function normalizeContainerRecord(raw: unknown, line?: string): DockerContainer {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const names = record.Names;
  const state = typeof record.State === 'string' ? record.State : '';
  const status = typeof record.Status === 'string' ? record.Status : '';
  const id = typeof record.ID === 'string' ? record.ID : typeof record.Id === 'string' ? record.Id : '';

  if (!id) {
    throw new OpenDevContainerError(
      'DOCKER_OUTPUT_PARSE_FAILED',
      'Docker returned a container entry without an ID.',
      line ?? JSON.stringify(raw)
    );
  }

  return {
    ID: id,
    Image: typeof record.Image === 'string' ? record.Image : '',
    Names: Array.isArray(names) ? names.join(',') : typeof names === 'string' ? names : '',
    State: state,
    Status: status || state
  };
}

export function parseDockerInspect(stdout: string, containerId: string): DockerInspect {
  try {
    const result = JSON.parse(stdout) as DockerInspect[];
    if (!result[0]) {
      throw new OpenDevContainerError('CONTAINER_NOT_FOUND', `Docker inspect returned no data for container ${containerId}.`);
    }
    return result[0];
  } catch (error: unknown) {
    if (error instanceof OpenDevContainerError) {
      throw error;
    }

    throw new OpenDevContainerError(
      'DOCKER_OUTPUT_PARSE_FAILED',
      `Docker inspect returned invalid JSON for container ${containerId}.`,
      formatErrorDetail(error)
    );
  }
}
