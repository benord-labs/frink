import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAutoModeRuleReportsForTests, autoModeRuleCounts, readUserAutoModeRules } from '.';

import * as sentry from '../../sentry/init';

const captureMainException = vi.spyOn(sentry, 'captureMainException').mockImplementation(() => {});

let tmpRoot: string;
let home: string;

function writeRawSettings(body: string): void {
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), body);
}

/** The keys these tests put in a user's ~/.claude/settings.json; `autoMode` may be malformed. */
type SettingsFixture = {
  model?: string;
  permissions?: { allow: string[] };
  env?: Record<string, string>;
  autoMode?: Record<string, string | boolean | (string | number)[]> | string;
};

function writeUserSettings(settings: SettingsFixture): void {
  writeRawSettings(JSON.stringify(settings));
}

beforeEach(() => {
  _resetAutoModeRuleReportsForTests();
  captureMainException.mockClear();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-auto-mode-rules-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  vi.stubEnv('FRINK_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readUserAutoModeRules', () => {
  it('sends nothing without a settings file, an autoMode block, or valid JSON', () => {
    expect(readUserAutoModeRules()).toEqual({});
    writeUserSettings({ model: 'opus' });
    expect(readUserAutoModeRules()).toEqual({});
    writeRawSettings('{ not json');
    expect(readUserAutoModeRules()).toEqual({});
  });

  it('carries allow, environment and classifyAllShell exactly as the user wrote them', () => {
    const environment = ['Source control: github.com/acme', 'Trusted domains: *.acme.dev'];
    const allow = ['$defaults', 'Deploying to staging is fine'];
    writeUserSettings({ autoMode: { environment, allow, classifyAllShell: true } });

    expect(readUserAutoModeRules()).toEqual({
      autoMode: { environment, allow, classifyAllShell: true },
    });
  });

  it("keeps Claude's built-in block rules in front of block lists written without $defaults", () => {
    writeUserSettings({
      autoMode: { soft_deny: ['Never run migrations'], hard_deny: ['$defaults', 'Never upload'] },
    });

    expect(readUserAutoModeRules()).toEqual({
      autoMode: {
        soft_deny: ['$defaults', 'Never run migrations'],
        hard_deny: ['$defaults', 'Never upload'],
      },
    });
  });

  it('keeps the built-in blocks when a block list is empty, which would otherwise clear them', () => {
    writeUserSettings({ autoMode: { soft_deny: [], allow: [] } });

    expect(readUserAutoModeRules()).toEqual({ autoMode: { soft_deny: ['$defaults'], allow: [] } });
  });

  it('drops only the mistyped keys, so the valid lists still reach Claude', async () => {
    writeUserSettings({
      autoMode: { allow: 'not a list', soft_deny: ['ok', 42], hard_deny: ['$defaults', 'Keep'] },
    });

    expect(readUserAutoModeRules()).toEqual({ autoMode: { hard_deny: ['$defaults', 'Keep'] } });
    await vi.waitFor(() => expect(captureMainException).toHaveBeenCalledTimes(1));
    expect(captureMainException.mock.calls[0]?.[1]).toEqual({ surface: 'claude-auto-mode-rules' });
  });

  it('reports a bad block once per process, not at every spawn', async () => {
    writeUserSettings({ autoMode: 'oops' });

    expect(readUserAutoModeRules()).toEqual({});
    expect(readUserAutoModeRules()).toEqual({});
    await vi.waitFor(() => expect(captureMainException).toHaveBeenCalled());
    expect(captureMainException).toHaveBeenCalledTimes(1);
  });

  it('never carries other settings keys or a project-level autoMode', () => {
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMode: { allow: ['Anything goes'] } }),
    );
    writeUserSettings({
      permissions: { allow: ['Bash(*)'] },
      env: { SECRET: 'x' },
      autoMode: { allow: ['$defaults', 'Mine'] },
    });

    expect(readUserAutoModeRules()).toEqual({ autoMode: { allow: ['$defaults', 'Mine'] } });
  });
});

describe('autoModeRuleCounts', () => {
  it("counts the user's own rules per kind, never $defaults", () => {
    expect(
      autoModeRuleCounts({
        autoMode: {
          environment: ['$defaults', 'Org: acme'],
          allow: ['$defaults', 'A', 'B'],
          soft_deny: ['$defaults', 'C'],
          hard_deny: ['$defaults'],
        },
      }),
    ).toEqual({ allow: 2, block: 1, environment: 1 });
    expect(autoModeRuleCounts({})).toEqual({ allow: 0, block: 0, environment: 0 });
  });
});
