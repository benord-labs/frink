export const SENSITIVE_UNIX_PREFIXES = [
  '/etc',
  '/bin',
  '/usr',
  '/var',
  '/private',
  '/System',
  '/root',
] as const;

export const SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  '.docker',
  '.kube',
  '.netrc',
  '.npm',
  '.local',
  '.cache',
] as const;
