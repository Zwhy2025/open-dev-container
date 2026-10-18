import { execContainerCli, type ExecFn } from './containerExec';
import { execFileAsync } from './commandRunner';
import { OpenDevContainerError, formatErrorDetail } from './errors';
import type { DockerContainer, DockerInspect, ExecResult } from './types';

export type DockerClientOptions = {
  dockerPath: string;
  sshTarget?: string;
  run?: ExecFn;
};

export class DockerClient {
  private readonly dockerPath: string;
  private readonly sshTarget?: string;
  private readonly run: ExecFn;

  constructor(options: DockerClientOptions) {
    this.dockerPath = options.dockerPath;
    this.sshTarget = options.sshTarget;
    this.run = options.run ?? execFileAsync;
  }

  private exec(args: string[], maxBuffer = 1024 * 1024): Promise<ExecResult> {
    return execContainerCli(this.dockerPath, args, this.sshTarget, { maxBuffer }, this.run);
  }

  async listRunningContainers(): Promise<DockerContainer[]> {
    const { stdout } = await this.exec(['ps', '--format', '{{json .}}']);
    return parseDockerContainerList(stdout);
  }

  async listAllContainers(): Promise<DockerContainer[]> {
    const { stdout } = await this.exec(['ps', '-a', '--format', '{{json .}}']);
    return parseDockerContainerList(stdout);
  }

  async startContainer(containerId: string): Promise<void> {
    await this.exec(['start', containerId]);
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.exec(['stop', containerId]);
  }

  async restartContainer(containerId: string): Promise<void> {
    await this.exec(['restart', containerId]);
  }

  async removeContainer(containerId: string): Promise<void> {
    await this.exec(['rm', '-f', containerId]);
  }

  async inspectContainer(containerId: string): Promise<DockerInspect> {
    const { stdout } = await this.exec(['inspect', containerId], 10 * 1024 * 1024);
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
