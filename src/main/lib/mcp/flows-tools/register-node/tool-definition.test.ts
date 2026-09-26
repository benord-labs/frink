import { describe, expect, it } from 'vitest';
import { REGISTER_NODE_TOOL } from './tool-definition';

describe('REGISTER_NODE_TOOL', () => {
  it('publishes inline manifest + scriptContent and packagePath as alternative sources', () => {
    const { properties } = REGISTER_NODE_TOOL.inputSchema;
    expect(properties.manifest).toEqual(
      expect.objectContaining({ type: 'object', required: ['name', 'entrypoint'] }),
    );
    expect(properties.manifest.properties.name.description).toContain('/^[a-z0-9][a-z0-9_-]*$/');
    expect(properties.manifest.properties.entrypoint.description).toContain('.js filename');
    expect(properties.scriptContent).toEqual(expect.objectContaining({ type: 'string' }));
    expect(properties.packagePath).toEqual(expect.objectContaining({ type: 'string' }));
    expect(properties.packagePath.description).toContain('contains manifest.json');
    expect(REGISTER_NODE_TOOL.inputSchema.required).toEqual([]);
    expect(REGISTER_NODE_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(REGISTER_NODE_TOOL.description).toContain('manifest + scriptContent inline');
    expect(REGISTER_NODE_TOOL.description).toContain('never both');
  });
});
