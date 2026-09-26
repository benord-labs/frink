import { describe, expect, it } from 'vitest';
import { CODEX_CLI_MODELS } from '../../../shared/lib/codex-cli-models';
import { shouldForwardTaskModel } from './index';

describe('Codex model task forwarding', () => {
  it.each(CODEX_CLI_MODELS.map((model) => model.id))(
    'forwards %s to flow task execution',
    (pickerId) => {
      expect(shouldForwardTaskModel(pickerId, 'codex')).toBe(true);
    },
  );
});
