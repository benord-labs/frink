import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs the real helper in bash against the env a Frink Dev agent shell actually carries.
const helper = join(import.meta.dirname, 'scrub-host-env.sh');

function scrubbedEnv(env) {
  const run = spawnSync('bash', ['-c', `. "${helper}"; qa_scrub_host_dev_env; env`], {
    env,
    encoding: 'utf-8',
  });
  expect(run.status, run.stderr).toBe(0);
  return Object.fromEntries(
    run.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

describe('qa_scrub_host_dev_env', () => {
  const hostDevEnv = {
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_EXEC_PATH: '/host/electron',
    ELECTRON_CLI_ARGS: '[]',
    ELECTRON_ENTRY: '/host/out/main/index.js',
    NODE_ENV: 'development',
    NODE_ENV_ELECTRON_VITE: 'development',
    VITE_POSTHOG_KEY: 'host-key',
    MAIN_VITE_FRINK_CLOUD_URL: 'http://host',
    RENDERER_VITE_SENTRY_DSN: 'host-dsn',
  };
  const operatorEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/Users/op',
    FRINK_HOME: '/rig/home',
    ELECTRON_MIRROR: 'https://mirror.example/',
  };

  it("drops every variable electron-vite set for the host's dev app", () => {
    const env = scrubbedEnv({ ...operatorEnv, ...hostDevEnv });
    for (const name of Object.keys(hostDevEnv)) expect(env).not.toHaveProperty(name);
  });

  it("keeps the operator's own env, including Electron download settings the binary install needs", () => {
    const env = scrubbedEnv({ ...operatorEnv, ...hostDevEnv });
    expect(env).toMatchObject(operatorEnv);
  });
});
