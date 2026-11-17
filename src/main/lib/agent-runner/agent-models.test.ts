import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../db';
import { setPreference } from '../db/repos/composer-settings';
import { freshDb } from '../db/test-utils/fresh-db';
import { rememberAgentModels, rememberedAgentModels } from './agent-models';

const GPT = { id: 'openai/gpt-5', name: 'GPT-5' };
const PICKLE = { id: 'opencode/big-pickle', name: 'Big Pickle' };

describe('agent models', () => {
  let db = freshDb();

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
  });

  it('keeps the last list an agent reported, through an empty report', () => {
    rememberAgentModels('opencode', [GPT, PICKLE]);
    expect(rememberedAgentModels('opencode')).toEqual([GPT, PICKLE]);

    rememberAgentModels('opencode', [PICKLE]);
    rememberAgentModels('opencode', []);
    expect(rememberedAgentModels('opencode')).toEqual([PICKLE]);
  });

  it("keeps each agent's list apart, and lists none for an agent that never reported", () => {
    rememberAgentModels('opencode', [PICKLE]);
    rememberAgentModels('copilot', [GPT]);

    expect(rememberedAgentModels('opencode')).toEqual([PICKLE]);
    expect(rememberedAgentModels('copilot')).toEqual([GPT]);
    expect(rememberedAgentModels('grok')).toEqual([]);
  });

  it('lets the turn go on when the list cannot be saved', () => {
    vi.mocked(database.getDatabase).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() => rememberAgentModels('opencode', [GPT])).not.toThrow();
  });

  it('reads a list saved on this computer before the app restarted', () => {
    setPreference(db, 'agentModels.opencode', [GPT]);

    expect(rememberedAgentModels('opencode')).toEqual([GPT]);
  });
});
