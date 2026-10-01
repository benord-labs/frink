// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PICKER_MODELS,
  CODEX_MODELS,
  codexModelToPickerItem,
} from '../../../../shared/lib/models';
import type { CodexSpeed } from '../../../../shared/types/execution';
import { extendedThinkingEnabledAtom } from '../../../lib/atoms';
import { codexSpeedAtomFamily } from '../../../lib/atoms/codex-speed';
import { type ModelItem, ModelSelector } from './model-selector';

const capabilities = vi.hoisted(() => ({ supportsXhigh: true, supportsUltra: true }));

// Stub the trpc client (the real module creates a client at load needing the electronTRPC preload
// global, absent in tests). Only the bundled-CLI capability query is consumed here.
vi.mock('../../../lib/trpc', () => ({
  trpc: {
    claudeSettings: {
      getBundledClaudeCapabilities: { useQuery: () => ({ data: capabilities }) },
    },
  },
}));

const CODEX_ITEMS: ModelItem[] = CODEX_MODELS.map(codexModelToPickerItem);
const byId = (id: string): ModelItem => {
  const m = [...CLAUDE_PICKER_MODELS, ...CODEX_ITEMS].find((x) => x.id === id);
  if (!m) throw new Error(`no model ${id}`);
  return m;
};

const base = {
  availableModels: CLAUDE_PICKER_MODELS,
  onOpenChange: vi.fn(),
};

type Props = ComponentProps<typeof ModelSelector>;

function renderPicker(props: Partial<Props> & Pick<Props, 'selectedModel'>, thinking = true) {
  const store = createStore();
  store.set(extendedThinkingEnabledAtom, thinking);
  const onModelChange = vi.fn();
  render(
    <Provider store={store}>
      <ModelSelector {...base} isOpen onModelChange={onModelChange} {...props} />
    </Provider>,
  );
  return { onModelChange, store };
}

const trigger = () => screen.getByRole('button', { name: /^Model: / });
const slider = () => screen.getByRole('slider', { name: 'Effort' });
/** The picker focuses its pane's control a frame after mount (once Radix registers the thumb). */
const focusedSlider = async () => {
  await waitFor(() => expect(slider()).toHaveFocus());
  return slider();
};

afterEach(() => {
  cleanup();
  capabilities.supportsXhigh = true;
  capabilities.supportsUltra = true;
});

describe('trigger label', () => {
  it.each([
    ['opus-4.7', 'Opus 4.7'],
    ['opus-4.7-max', 'Opus 4.7 · Max'],
    ['codex-gpt-6-astra-high', 'GPT-6 Astra · High'],
  ])('%s reads "%s" (the default Medium tier is hidden)', (id, label) => {
    render(
      <ModelSelector {...base} isOpen={false} onModelChange={vi.fn()} selectedModel={byId(id)} />,
    );
    expect(trigger()).toHaveAttribute('title', label);
  });

  it('marks Ultra as a mode, not just another tier', () => {
    const renderTrigger = (id: string) =>
      render(
        <ModelSelector {...base} isOpen={false} onModelChange={vi.fn()} selectedModel={byId(id)} />,
      );
    const { unmount } = renderTrigger('opus-5.5-max');
    expect(trigger().querySelector('.chroma-text')).toBeNull();
    unmount();
    renderTrigger('opus-5.5-low-ultra');
    expect(trigger().querySelector('.chroma-text-animate')).toHaveTextContent('Ultra');
    expect(trigger()).toHaveTextContent('Opus 5.5 · Low · Ultra');
    expect(trigger()).toHaveAccessibleName('Model: Opus 5.5 · Low · Ultra — parallel agents on');
  });

  it('falls back to "Auto" in chat and the inherit label in flow', () => {
    const { unmount } = render(
      <ModelSelector {...base} isOpen={false} onModelChange={vi.fn()} selectedModel={undefined} />,
    );
    expect(trigger()).toHaveAttribute('title', 'Auto');
    unmount();
    render(
      <ModelSelector
        {...base}
        mode="flow"
        isOpen={false}
        onModelChange={vi.fn()}
        selectedModel={undefined}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Agent default');
  });
});

describe('effort pane', () => {
  it('opens on the slider, focused, and reads the effort over the model', async () => {
    renderPicker({ selectedModel: byId('opus-4.7-high') });
    await focusedSlider();
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    expect(
      screen.getByRole('button', { name: 'Opus 4.7, High effort. Change model' }),
    ).toBeVisible();
  });

  it('commits the neighbouring tier id as the slider moves', async () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-4.7-high') });
    fireEvent.keyDown(await focusedSlider(), { key: 'ArrowRight' });
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-4.7-xhigh'));
  });

  it('moves Codex effort within the same model', async () => {
    const { onModelChange } = renderPicker({
      availableModels: CODEX_ITEMS,
      modelVariant: 'codex',
      selectedModel: byId('codex-gpt-6-astra-medium'),
    });
    fireEvent.keyDown(await focusedSlider(), { key: 'ArrowRight' });
    expect(onModelChange).toHaveBeenCalledWith(byId('codex-gpt-6-astra-high'));
  });

  it('labels the 1M window by effort, not the raw "1M · High" detail', () => {
    renderPicker({ selectedModel: byId('opus-4.7-1m-high') });
    expect(
      screen.getByRole('button', { name: 'Opus 4.7, High effort. Change model' }),
    ).toBeVisible();
  });

  it('offers context windows under the model list, keeping effort, with 1M marked default', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-4.7-high') });
    expect(screen.queryByRole('radiogroup', { name: 'Context window' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    const group = screen.getByRole('radiogroup', { name: 'Context window' });
    expect(within(group).getByRole('radio', { name: '200k', checked: true })).toBeVisible();
    fireEvent.click(within(group).getByRole('radio', { name: '1M Default' }));
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-4.7-1m-high'));
  });

  it('shows no context section for a single-window model', () => {
    renderPicker({ selectedModel: byId('opus-5') });
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    expect(screen.queryByRole('radiogroup', { name: 'Context window' })).toBeNull();
  });

  it('resets to the family default, and hides reset when already there', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-5-max') });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-5'));
    cleanup();
    renderPicker({ selectedModel: byId('opus-5') });
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
  });

  it('reset also turns Thinking back on (its default)', () => {
    const { onModelChange, store } = renderPicker({ selectedModel: byId('opus-5') }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(store.get(extendedThinkingEnabledAtom)).toBe(true);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('disables the slider while Claude Thinking is off (effort would not be sent)', () => {
    renderPicker({ selectedModel: byId('opus-4.7-high') }, false);
    expect(slider()).toHaveAttribute('data-disabled');
    expect(screen.getByText('Thinking off')).toBeVisible();
    fireEvent.click(screen.getByRole('switch', { name: 'Thinking' }));
    expect(slider()).not.toHaveAttribute('data-disabled');
  });

  it('drops the Extra High stop and says why when the bundled CLI lacks it', () => {
    capabilities.supportsXhigh = false;
    renderPicker({ selectedModel: byId('opus-4.7-high') });
    expect(slider()).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByText(/Extra High needs a newer Claude CLI/)).toBeVisible();
  });
});

describe('Ultra switch', () => {
  const ultraSwitch = () => screen.getByRole('switch', { name: 'Ultra' });

  it('turns Ultra on at the chosen effort, and off again', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-5.5-low') });
    expect(ultraSwitch()).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(ultraSwitch());
    expect(onModelChange).toHaveBeenLastCalledWith(byId('opus-5.5-low-ultra'));
    cleanup();
    const next = renderPicker({ selectedModel: byId('opus-5.5-low-ultra') });
    expect(ultraSwitch()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(ultraSwitch());
    expect(next.onModelChange).toHaveBeenLastCalledWith(byId('opus-5.5-low'));
  });

  it('keeps Ultra on as the slider moves', async () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-5.5-low-ultra') });
    expect(slider()).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(await focusedSlider(), { key: 'ArrowRight' });
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-5.5-ultra'));
  });

  it('stays usable with Thinking off: it is not an effort', () => {
    renderPicker({ selectedModel: byId('opus-5.5') }, false);
    expect(ultraSwitch()).not.toBeDisabled();
  });

  it('is hidden when the bundled CLI cannot run it, unless already on (so it can be turned off)', () => {
    capabilities.supportsUltra = false;
    renderPicker({ selectedModel: byId('opus-5.5-xhigh') });
    expect(screen.queryByRole('switch', { name: 'Ultra' })).toBeNull();
    cleanup();
    renderPicker({ selectedModel: byId('opus-5.5-xhigh-ultra') });
    expect(ultraSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('is absent for a family the CLI offers no Ultra on', () => {
    renderPicker({ selectedModel: byId('sonnet-high') });
    expect(screen.queryByRole('switch', { name: 'Ultra' })).toBeNull();
  });

  it('reset turns Ultra off', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-5.5-ultra') });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-5.5'));
  });
});

describe('model list pane', () => {
  it('lists one row per family and lands a switch on its default 1M window, keeping effort', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-4.7-high') });
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    expect(screen.getByRole('option', { name: 'Opus 4.7', selected: true })).toBeVisible();
    expect(screen.queryByRole('option', { name: /· 1M/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Opus 4.6' }));
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-1m-high'));
  });

  it('falls back to the target default when it lacks the current effort', () => {
    const { onModelChange } = renderPicker({ selectedModel: byId('opus-4.7-max') });
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Opus 4.6' }));
    expect(onModelChange).toHaveBeenCalledWith(byId('opus-1m'));
  });

  it('opens on the list, Thinking still reachable, for a model with no effort choice', async () => {
    renderPicker({ selectedModel: byId('haiku') });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Haiku 4.5', selected: true })).toHaveFocus(),
    );
    expect(screen.getByRole('switch', { name: 'Thinking' })).toBeVisible();
  });

  it('walks the rows with the arrow keys', async () => {
    renderPicker({ selectedModel: byId('haiku') });
    const haiku = screen.getByRole('option', { name: 'Haiku 4.5' });
    await waitFor(() => expect(haiku).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'Sonnet 4.6' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    expect(haiku).toHaveFocus();
  });

  it('survives a selection missing from the list', () => {
    renderPicker({ selectedModel: { id: 'gone', name: 'Gone' } });
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
  });

  it('opens model settings and closes', () => {
    const onOpenModelSettings = vi.fn();
    const onOpenChange = vi.fn();
    renderPicker({ selectedModel: byId('haiku'), onOpenModelSettings, onOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Model visibility & accounts…' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenModelSettings).toHaveBeenCalled();
  });

  it('flow: the inherit row is selected when nothing is stored, and clears on pick', () => {
    const onClearModel = vi.fn();
    const onOpenChange = vi.fn();
    renderPicker({ mode: 'flow', selectedModel: undefined, onClearModel, onOpenChange });
    fireEvent.click(screen.getByRole('option', { name: 'Agent default', selected: true }));
    expect(onClearModel).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('provider controls', () => {
  const codex = (id: string, chatId?: string) => ({
    availableModels: CODEX_ITEMS,
    modelVariant: 'codex' as const,
    selectedModel: byId(id),
    chatId,
  });

  it('shows no Thinking control for Codex (the transport ignores it)', () => {
    renderPicker(codex('codex-gpt-6-astra-medium', 'chat-1'));
    expect(screen.queryByRole('switch', { name: 'Thinking' })).toBeNull();
  });

  it.each([
    ['codex-gpt-5.6-sol-medium', '2.5×'],
    ['codex-gpt-5.4-medium', '2×'],
  ])('discloses the Fast credit multiplier for %s while Fast is off', (id, credits) => {
    renderPicker(codex(id, 'chat-1'));
    const fast = screen.getByRole('switch', { name: /^Fast mode — 1\.5× speed/ });
    expect(fast).toHaveAttribute('aria-checked', 'false');
    expect(fast).toHaveTextContent(credits);
  });

  it('offers Ultrafast on Astra only, and it replaces Fast rather than stacking', () => {
    const { store } = renderPicker(codex('codex-gpt-6-astra-medium', 'chat-u'));
    const ultrafast = screen.getByRole('switch', { name: /^Ultrafast mode — up to 8× speed/ });
    expect(ultrafast).toHaveTextContent('8×');

    fireEvent.click(screen.getByRole('switch', { name: /^Fast mode/ }));
    fireEvent.click(ultrafast);
    expect(store.get(codexSpeedAtomFamily('chat-u'))).toBe('ultrafast');
    expect(screen.getByRole('switch', { name: /^Fast mode/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    fireEvent.click(ultrafast);
    expect(store.get(codexSpeedAtomFamily('chat-u'))).toBe('standard');
    cleanup();

    renderPicker(codex('codex-gpt-6.1-sol-medium', 'chat-u'));
    expect(screen.queryByRole('switch', { name: /Ultrafast/ })).toBeNull();
  });

  it('omits Fast for a model with no priority tier — never a live-but-inert control', () => {
    renderPicker(codex('codex-gpt-5.4-mini-medium', 'chat-1'));
    expect(screen.queryByRole('switch', { name: /Fast mode/ })).toBeNull();
  });

  it('stages Fast on the New Chat form (no chat id yet), surviving a reopen', () => {
    const speedRef: { current: CodexSpeed } = { current: 'standard' };
    renderPicker({ ...codex('codex-gpt-5.6-sol-medium'), newChatSpeedRef: speedRef });
    fireEvent.click(screen.getByRole('switch', { name: /Fast mode/ }));
    expect(speedRef.current).toBe('fast');
    cleanup();
    renderPicker({ ...codex('codex-gpt-5.6-sol-medium'), newChatSpeedRef: speedRef });
    expect(screen.getByRole('switch', { name: /Fast mode/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('omits Fast with neither a chat nor a New Chat form to hold it', () => {
    renderPicker(codex('codex-gpt-5.6-sol-medium'));
    expect(screen.queryByRole('switch', { name: /Fast mode/ })).toBeNull();
  });

  it('omits Fast in flow forms, which carry their own Fast setting', () => {
    renderPicker({ ...codex('codex-gpt-5.6-sol-medium'), mode: 'flow' });
    expect(screen.queryByRole('switch', { name: /Fast mode/ })).toBeNull();
  });

  it('toggles Fast per chat and renders a Flow-seeded ON state', () => {
    const { store } = renderPicker(codex('codex-gpt-5.6-sol-medium', 'chat-9'));
    fireEvent.click(screen.getByRole('switch', { name: /Fast mode/ }));
    expect(store.get(codexSpeedAtomFamily('chat-9'))).toBe('fast');
    expect(screen.getByRole('switch', { name: /Fast mode/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
