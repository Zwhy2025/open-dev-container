import { classifyDockerCommandError, execFileAsync } from './commandRunner';
import { OpenDevContainerError } from './errors';
import { parseMarker, shellQuote } from './sshConfig';

export const CONTAINER_CONFIG_DIR = '/tmp/open-dev-container';
export const CONTAINER_SSHD_CONFIG = `${CONTAINER_CONFIG_DIR}/sshd_config`;
export const CONTAINER_FORCE_COMMAND_SCRIPT = `${CONTAINER_CONFIG_DIR}/ssh_force_command.sh`;

export async function prepareContainerSshd(
  dockerPath: string,
  containerId: string,
  remoteUser: string,
  publicKey: string,
  installSshd: boolean
): Promise<string> {
  const script = buildPrepareSshdScript(remoteUser, publicKey, installSshd);

  try {
    const { stdout, stderr } = await execFileAsync(dockerPath, ['exec', '-u', '0', containerId, 'sh', '-lc', script], {
      maxBuffer: 5 * 1024 * 1024
    });

    const sshdPath = parseMarker(stdout, 'OPEN_DEV_CONTAINER_SSHD_PATH');
    if (!sshdPath) {
      throw new OpenDevContainerError('SSHD_CONFIG_INVALID', 'Could not validate sshd configuration inside the container.', stderr || stdout);
    }
    return sshdPath;
  } catch (error: unknown) {
    const scriptError = parseManagedScriptError(error);
    if (scriptError) {
      throw scriptError;
    }
    throw classifyDockerCommandError(error, dockerPath, ['exec', '-u', '0', containerId, 'sh', '-lc', script]);
  }
}

export function parseManagedScriptError(error: unknown): OpenDevContainerError | undefined {
  const output = error instanceof OpenDevContainerError ? [error.message, error.detail].filter(Boolean).join('\n') : error instanceof Error ? error.stack || error.message : String(error);
  const match = output.match(/OPEN_DEV_CONTAINER_ERROR=([A-Z_]+)/);
  if (!match) {
    return undefined;
  }

  const code = match[1];
  switch (code) {
    case 'MISSING_SSHD':
      return new OpenDevContainerError(
        'MISSING_SSHD',
        'sshd is missing in the container. Enable `openDevContainer.installSshd` or install `openssh-server`.',
        output
      );
    case 'NO_PACKAGE_MANAGER':
      return new OpenDevContainerError(
        'NO_PACKAGE_MANAGER',
        'The container does not have a supported package manager to install `openssh-server`.',
        output
      );
    case 'REMOTE_USER_NOT_FOUND':
      return new OpenDevContainerError(
        'REMOTE_USER_NOT_FOUND',
        'The configured remote user does not exist in the container.',
        output
      );
    case 'SSHD_CONFIG_INVALID':
      return new OpenDevContainerError(
        'SSHD_CONFIG_INVALID',
        'The generated sshd configuration failed validation.',
        output
      );
    case 'SSHD_NOT_FOUND':
      return new OpenDevContainerError('SSHD_CONFIG_INVALID', 'Unable to locate sshd after installation.', output);
    default:
      return new OpenDevContainerError('DOCKER_EXEC_FAILED', 'The container preparation script failed.', output);
  }
}

export function buildPrepareSshdScript(remoteUser: string, publicKey: string, installSshd: boolean): string {
  const installBlock = installSshd
    ? `
if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y openssh-server
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssh-server
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openssh-server
  elif command -v yum >/dev/null 2>&1; then
    yum install -y openssh-server
  elif command -v microdnf >/dev/null 2>&1; then
    microdnf install -y openssh-server
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm openssh
  else
    echo "OPEN_DEV_CONTAINER_ERROR=NO_PACKAGE_MANAGER" >&2
    echo "openssh-server is missing and no supported package manager was found." >&2
    exit 86
  fi
fi
`
    : `
if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  echo "OPEN_DEV_CONTAINER_ERROR=MISSING_SSHD" >&2
  echo "sshd is missing. Enable openDevContainer.installSshd or install openssh-server in the container." >&2
  exit 86
fi
`;

  return `
set -eu

emit_error() {
  echo "OPEN_DEV_CONTAINER_ERROR=$1" >&2
  shift
  printf '%s\n' "$@" >&2
  exit 1
}

REMOTE_USER=${shellQuote(remoteUser)}
PUBLIC_KEY=${shellQuote(publicKey)}
${installBlock}
SSHD_PATH="$(command -v sshd || true)"
if [ -z "$SSHD_PATH" ] && [ -x /usr/sbin/sshd ]; then
  SSHD_PATH=/usr/sbin/sshd
fi
if [ -z "$SSHD_PATH" ]; then
  emit_error SSHD_NOT_FOUND "Unable to locate sshd after installation."
fi

mkdir -p /run/sshd /var/run/sshd ${CONTAINER_CONFIG_DIR}
ssh-keygen -A >/dev/null 2>&1 || true

cat > ${shellQuote(CONTAINER_FORCE_COMMAND_SCRIPT)} <<'EOF'
#!/bin/sh
# Run the requested command (or a login shell) and exit with its status.
# The channel must close when the command ends: Remote SSH clients such as
# open-remote-ssh wait for exec() to close before continuing, so keeping the
# session alive here would hang the connection forever.
# Commands run exactly like stock sshd does it: "$SHELL -c", *not* a login
# shell. Login startup files (/etc/profile, ~/.profile) often print banners
# or exec an interactive shell, which breaks Remote SSH's install script.
if [ -n "\${SSH_ORIGINAL_COMMAND:-}" ]; then
  CMD=$SSH_ORIGINAL_COMMAND
  # open-remote-ssh installs the VSCodium server with "... | bash -l". A *login*
  # shell sources the container's profile/rc files; in hand-built images those
  # frequently read stdin or exit for non-interactive shells, which swallows the
  # piped install script -> the client fails with "Failed parsing install script
  # output". The install needs no login environment, so strip the login shell.
  case "$CMD" in
    *"| bash -l")      CMD="\${CMD%| bash -l}| bash" ;;
    *"| bash --login") CMD="\${CMD%| bash --login}| bash" ;;
  esac
  exec "\${SHELL:-/bin/sh}" -c "$CMD"
fi
# Interactive session: login shell.
exec "\${SHELL:-/bin/sh}" -l
EOF
chmod 755 ${shellQuote(CONTAINER_FORCE_COMMAND_SCRIPT)}

if command -v getent >/dev/null 2>&1; then
  if ! getent passwd "$REMOTE_USER" >/dev/null 2>&1; then
    emit_error REMOTE_USER_NOT_FOUND "User \"$REMOTE_USER\" was not found in the container."
  fi
  HOME_DIR="$(getent passwd "$REMOTE_USER" | awk -F: '{print $6}' || true)"
else
  HOME_DIR=""
fi
if [ -z "$HOME_DIR" ]; then
  if [ "$REMOTE_USER" = "root" ]; then
    HOME_DIR=/root
  else
    HOME_DIR=/home/$REMOTE_USER
  fi
fi

mkdir -p "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$PUBLIC_KEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$PUBLIC_KEY" >> "$HOME_DIR/.ssh/authorized_keys"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
chown -R "$REMOTE_USER" "$HOME_DIR/.ssh" >/dev/null 2>&1 || true

cat > ${CONTAINER_SSHD_CONFIG} <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
PermitRootLogin yes
UsePAM no
PrintMotd no
LogLevel ERROR
PidFile /tmp/open-dev-container/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
ForceCommand ${CONTAINER_FORCE_COMMAND_SCRIPT}
EOF

if ! "$SSHD_PATH" -t -f ${CONTAINER_SSHD_CONFIG}; then
  emit_error SSHD_CONFIG_INVALID "Generated sshd configuration failed validation."
fi

echo "OPEN_DEV_CONTAINER_SSHD_PATH=$SSHD_PATH"
`;
}
