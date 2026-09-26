import { describe, expect, it } from 'vitest';
import { classifyNodeManifest } from './index';

describe('classifyNodeManifest', () => {
  it('routes leftover plugin kinds to the plugin branch and scripts to the script branch', () => {
    expect(
      classifyNodeManifest(
        { name: 'shortcut_get_story', kind: 'plugin_mcp_tool' },
        'shortcut_get_story',
      ),
    ).toEqual({ branch: 'plugin' });
    expect(
      classifyNodeManifest(
        { name: 'slack_send_message', kind: 'plugin_operation' },
        'slack_send_message',
      ),
    ).toEqual({ branch: 'plugin' });
    expect(classifyNodeManifest({ name: 'my-node', kind: 'script' }, 'my-node')).toEqual({
      branch: 'script',
    });
    expect(classifyNodeManifest({ name: 'my-node' }, 'my-node')).toEqual({ branch: 'script' });
    expect(classifyNodeManifest('not-an-object', 'my-node')).toEqual({ branch: 'script' });
  });

  it('rejects an unknown kind', () => {
    const result = classifyNodeManifest({ kind: 'wasm' }, 'my-node');
    expect(result.branch).toBe('error');
    if (result.branch === 'error') expect(result.error).toContain('invalid "kind"');
  });

  it('rejects owner on a script manifest', () => {
    const result = classifyNodeManifest({ owner: { pluginId: 'shortcut' } }, 'my-node');
    expect(result.branch).toBe('error');
    if (result.branch === 'error') expect(result.error).toContain('"owner" is only valid');
  });

  it('rejects a script squatting a plugin namespace via folder or manifest name', () => {
    for (const [dirName, manifest] of [
      ['shortcut_fake', { name: 'shortcut_fake', entrypoint: 'run.js' }],
      ['innocent', { name: 'clickup_create_task', entrypoint: 'run.js' }],
    ] as const) {
      const result = classifyNodeManifest(manifest, dirName);
      expect(result.branch).toBe('error');
      if (result.branch === 'error') {
        expect(result.error).toContain("reserved for that plugin's Flow steps");
      }
    }
  });
});
