export type DockerContainer = {
  ID: string;
  Image: string;
  Names: string;
  State: string;
  Status: string;
  Ports?: string;
};

export type DockerMount = {
  Type?: string;
  Source?: string;
  Destination?: string;
};

export type DockerInspect = {
  Id: string;
  Name?: string;
  Config?: {
    User?: string;
    WorkingDir?: string;
  };
  Mounts?: DockerMount[];
};

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export type ConnectionSettings = {
  dockerPath: string;
  remoteUser: string;
  workspaceFolder: string;
  installSshd: boolean;
  openInNewWindow: boolean;
  sshConfigPath: string;
  // SSH host alias the container CLI runs on.  Empty when the window works
  // against the local machine.
  sshTarget?: string;
};

export type RecentConnection = {
  connectionKey: string;
  containerId: string;
  containerName: string;
  image: string;
  hostAlias: string;
  workspaceFolder: string;
  dockerPath: string;
  remoteUser: string;
  sshConfigPath: string;
  lastAttachedAt: number;
  lastStatus: string;
  workingDir: string;
  mountSummary: string;
};

export type CommandErrorCode =
  | 'DOCKER_CLI_MISSING'
  | 'DOCKER_DAEMON_UNAVAILABLE'
  | 'DOCKER_PERMISSION_DENIED'
  | 'DOCKER_OUTPUT_PARSE_FAILED'
  | 'DOCKER_EXEC_FAILED'
  | 'CONTAINER_NOT_FOUND'
  | 'CONTAINER_SHELL_MISSING'
  | 'SSH_KEYGEN_MISSING'
  | 'HOST_STORAGE_UNAVAILABLE'
  | 'INVALID_REMOTE_USER'
  | 'MISSING_SSHD'
  | 'NO_PACKAGE_MANAGER'
  | 'REMOTE_USER_NOT_FOUND'
  | 'SSHD_CONFIG_INVALID'
  | 'SSH_CONFIG_WRITE_FAILED'
  | 'REMOTE_OPEN_FAILED'
  | 'NO_RECENT_CONNECTION'
  | 'NO_RUNNING_CONTAINERS'
  | 'UNKNOWN';
