// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { CodexAccountTiers } from '../../../../../../shared/lib/codex-cli-models';
import {
  FlowSpeedSettings,
  fastModeDescription,
  flowUltrafastCredits,
  ultrafastDescription,
} from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

describe('fastModeDescription', () => {
  it('labels speed and the selected model ChatGPT credit multiplier separately', () => {
    expect(fastModeDescription('codex-gpt-5.6-sol-medium')).toBe(
      'Runs Agent steps at 1.5× model speed for 2.5× ChatGPT credits per turn. API-key pricing differs.',
    );
    expect(fastModeDescription('codex-gpt-5.4-medium')).toContain(
      '1.5× model speed for 2× ChatGPT credits',
    );
  });

  it('does not promise Fast for an unsupported or unspecified default model', () => {
    expect(fastModeDescription('codex-gpt-5.4-mini-medium')).toContain(
      'The default model has no Fast tier.',
    );
    expect(fastModeDescription(undefined)).toContain('Applies only to supported OpenAI models.');
  });
});

describe('ultrafastDescription', () => {
  it('states the unattended cost on a model that offers it, and plain standard speed otherwise', () => {
    expect(ultrafastDescription(8)).toContain('up to 8× faster for 8× ChatGPT credits');
    expect(ultrafastDescription(8)).toContain('even when nobody is watching');
    expect(ultrafastDescription(null)).toBe(
      'No step uses a model with Ultrafast, so steps run at standard speed.',
    );
  });
});

describe('flowUltrafastCredits', () => {
  const pro = { 'gpt-6-astra': ['fast' as const, 'ultrafast' as const] };
  const step = (model?: string) => ({
    id: model ?? 'inherits',
    blockType: 'agent',
    config: { model },
  });

  it('offers Ultrafast when only a step picks GPT-6 Astra, with no flow default', () => {
    expect(flowUltrafastCredits(undefined, [step('codex-gpt-6-astra-high')], pro)).toBe(8);
  });

  it('offers it from the flow default when steps inherit their model', () => {
    expect(flowUltrafastCredits('codex-gpt-6-astra-medium', [step()], pro)).toBe(8);
  });

  it('does not offer it when no step can use it', () => {
    expect(
      flowUltrafastCredits('codex-gpt-6.1-sol-high', [step('opus-4.8'), step()], pro),
    ).toBeNull();
    expect(flowUltrafastCredits(undefined, [], pro)).toBeNull();
  });

  it('does not offer it to an account without the tier', () => {
    const plus = { 'gpt-6-astra': ['fast' as const] };
    expect(flowUltrafastCredits('codex-gpt-6-astra-medium', [step()], plus)).toBeNull();
  });
});

describe('FlowSpeedSettings', () => {
  /** Renders against a Codex account with `tiers`, resolving once its catalog read has landed. */
  async function renderSpeeds(tiers: CodexAccountTiers | null, codexSpeed?: 'fast' | 'ultrafast') {
    const answered = vi.fn();
    const answer = (op: Operation) => {
      answered(op.path);
      return Promise.resolve(tiers && { tiers, defaultSlug: null });
    };
    renderWithTrpc(
      <FlowSpeedSettings
        settings={{ defaultModel: 'codex-gpt-6-astra-medium', codexSpeed }}
        nodes={[]}
        onSettingsChange={() => {}}
      />,
      answer,
    );
    await waitFor(() => expect(answered).toHaveBeenCalledWith('usage.getCodexAccountCatalog'));
    await act(async () => {});
  }
  const row = (name: RegExp) => screen.queryByRole('switch', { name });

  const cases: [string, CodexAccountTiers | null, boolean, boolean][] = [
    ['a free account', { 'gpt-5.5': [] }, false, false],
    ['a Plus account', { 'gpt-6-astra': ['fast'] }, true, false],
    ['a Pro 500 account', { 'gpt-6-astra': ['fast', 'ultrafast'] }, true, true],
    ['an account whose tiers are unknown', null, false, false],
  ];

  it.each(cases)('offers %s only the speeds it has', async (_, tiers, fast, ultrafast) => {
    await renderSpeeds(tiers);
    // A loaded machine can land the catalog after the one flush renderSpeeds gives it.
    await waitFor(() => {
      expect(row(/^Fast mode/) !== null).toBe(fast);
      expect(row(/^Ultrafast mode/) !== null).toBe(ultrafast);
    });
  });

  it('keeps a speed that is already on, so it can be turned off', async () => {
    await renderSpeeds({ 'gpt-5.5': [] }, 'ultrafast');
    expect(row(/^Ultrafast mode/)).toBeChecked();
  });
});
