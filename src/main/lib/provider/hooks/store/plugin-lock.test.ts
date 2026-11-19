import { describe, expect, it } from 'vitest';
import { cliRunsPluginOnlyHooks, pluginOnlyHooksHold } from './plugin-lock';

type Cli = Parameters<typeof cliRunsPluginOnlyHooks>[0];

const started: Cli['initializationResult'] = async () => ({
  commands: [],
  agents: [],
  output_style: 'default',
  available_output_styles: [],
  models: [],
  account: {},
});
const answering = (pluginOnly: boolean): Cli => ({
  initializationResult: started,
  getHooksListing: async () => ({ policy: { pluginOnly } }),
});

describe('whether the plugin-only hooks lock holds for a Claude launch', () => {
  it('holds with no admin policy, and an org policy drops it unless the org opts in', async () => {
    const orgPolicy = { cleanupPeriodDays: 5 };

    expect(await pluginOnlyHooksHold()).toBe(true);
    expect(await pluginOnlyHooksHold(orgPolicy)).toBe(false);
    expect(await pluginOnlyHooksHold({ ...orgPolicy, parentSettingsBehavior: 'merge' })).toBe(true);
  });

  it("takes a started CLI's own answer, asked once the CLI has initialized", async () => {
    const asked: string[] = [];
    const cli: Cli = {
      initializationResult: async () => {
        asked.push('initialize');
        return started();
      },
      getHooksListing: async () => {
        asked.push('listing');
        return { policy: { pluginOnly: false } };
      },
    };

    expect(await cliRunsPluginOnlyHooks(answering(true))).toBe(true);
    expect(await cliRunsPluginOnlyHooks(cli)).toBe(false);
    expect(asked).toEqual(['initialize', 'listing']);
  });

  it('cannot say for a CLI that fails to start or will not list its hooks', async () => {
    const refused = async () => Promise.reject(new Error('not available on this connection'));

    expect(
      await cliRunsPluginOnlyHooks({ ...answering(true), initializationResult: refused }),
    ).toBe(null);
    expect(await cliRunsPluginOnlyHooks({ ...answering(true), getHooksListing: refused })).toBe(
      null,
    );
  });
});
