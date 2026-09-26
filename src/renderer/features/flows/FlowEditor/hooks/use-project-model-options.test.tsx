// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
} from '../../../../lib/flows/model-options/flow-model-options';
import { useProjectModelOptions } from './use-project-model-options';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';

function parseModelOptionsFromDom(): unknown {
  const raw = screen.getByTestId('model-options').textContent;
  if (raw == null || raw === '') {
    throw new Error('expected model-options textContent');
  }
  return JSON.parse(raw);
}

const querySnapshot = vi.hoisted(() => ({
  data: undefined as { type: string } | undefined,
  isLoading: false,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    claudeCode: {
      getResolvedAccount: {
        useQuery: () => ({
          data: querySnapshot.data,
          isLoading: querySnapshot.isLoading,
        }),
      },
    },
  },
}));

function Probe({
  projectId,
  model,
  flowDefaultModel,
  onClearModel = () => {},
}: {
  projectId?: string;
  model?: string;
  flowDefaultModel?: string;
  onClearModel?: () => void;
}): ReactElement {
  const { isCodexProject, modelOptions, modelPlaceholder } = useProjectModelOptions(projectId, {
    model,
    flowDefaultModel,
    onClearModel,
  });
  return (
    <>
      <span data-testid="codex">{String(isCodexProject)}</span>
      <span data-testid="model-options">{JSON.stringify(modelOptions)}</span>
      <span data-testid="placeholder">{modelPlaceholder}</span>
    </>
  );
}

describe('useProjectModelOptions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    querySnapshot.data = undefined;
    querySnapshot.isLoading = false;
  });

  it('treats as non-Codex when projectId is undefined', () => {
    render(<Probe />);
    expect(screen.getByTestId('codex')).toHaveTextContent('false');
    expect(parseModelOptionsFromDom()).toEqual(CLAUDE_MODEL_OPTIONS);
  });

  it('ignores resolved account while loading (avoids stale list for new projectId)', () => {
    querySnapshot.data = { type: 'codex' };
    querySnapshot.isLoading = true;
    render(<Probe projectId={PROJECT_ID} />);
    expect(screen.getByTestId('codex')).toHaveTextContent('false');
    expect(parseModelOptionsFromDom()).toEqual(CLAUDE_MODEL_OPTIONS);
  });

  it('uses the Codex catalog while the account query is loading when the saved id is codex-*', () => {
    querySnapshot.data = { type: 'claude-code' };
    querySnapshot.isLoading = true;
    render(<Probe projectId={PROJECT_ID} model="codex-gpt-5.3-codex-high" />);
    expect(screen.getByTestId('codex')).toHaveTextContent('true');
    expect(parseModelOptionsFromDom()).toEqual(CODEX_MODEL_OPTIONS);
  });

  it('uses the Claude model path when the loaded account is not codex', () => {
    querySnapshot.data = { type: 'claude-code' };
    querySnapshot.isLoading = false;
    render(<Probe projectId={PROJECT_ID} />);
    expect(screen.getByTestId('codex')).toHaveTextContent('false');
    expect(parseModelOptionsFromDom()).toEqual(CLAUDE_MODEL_OPTIONS);
  });

  it('returns CLAUDE_MODEL_OPTIONS by reference for Claude path', () => {
    querySnapshot.data = { type: 'claude-code' };
    querySnapshot.isLoading = false;
    const { result } = renderHook(() =>
      useProjectModelOptions(PROJECT_ID, { model: undefined, onClearModel: () => {} }),
    );
    expect(result.current.modelOptions).toBe(CLAUDE_MODEL_OPTIONS);
  });

  it('returns CODEX_MODEL_OPTIONS by reference for the Codex path', () => {
    querySnapshot.data = { type: 'codex' };
    querySnapshot.isLoading = false;
    const { result } = renderHook(() =>
      useProjectModelOptions(PROJECT_ID, { model: undefined, onClearModel: () => {} }),
    );
    expect(result.current.modelOptions).toBe(CODEX_MODEL_OPTIONS);
  });

  it('derives isCodexProject + codex model options when loaded account is codex', () => {
    querySnapshot.data = { type: 'codex' };
    querySnapshot.isLoading = false;
    render(<Probe projectId={PROJECT_ID} />);
    expect(screen.getByTestId('codex')).toHaveTextContent('true');
    // modelOptions must be codex so a codex flow-default renders a friendly label, not the raw picker id.
    expect(parseModelOptionsFromDom()).toEqual(CODEX_MODEL_OPTIONS);
  });

  it('uses Codex catalog when project unknown but the saved id is a codex-* one', () => {
    render(<Probe model="codex-gpt-5.3-codex-high" />);
    expect(screen.getByTestId('codex')).toHaveTextContent('true');
  });

  it('names the flow default in the inherit label, falling back to its raw id', () => {
    render(<Probe flowDefaultModel="opus-4.5" />);
    expect(screen.getByTestId('placeholder')).toHaveTextContent('Flow default (opus-4.5)');
  });

  it('labels the inherit option plainly when the flow has no default model', () => {
    render(<Probe />);
    expect(screen.getByTestId('placeholder')).toHaveTextContent(/^Flow default$/);
  });

  it('clears a Claude id on a Codex project', () => {
    querySnapshot.data = { type: 'codex' };
    const onClearModel = vi.fn();
    render(<Probe projectId={PROJECT_ID} model="sonnet" onClearModel={onClearModel} />);
    expect(onClearModel).toHaveBeenCalledTimes(1);
  });

  it('clears a Codex id on a Claude project', () => {
    querySnapshot.data = { type: 'claude-code' };
    const onClearModel = vi.fn();
    render(
      <Probe projectId={PROJECT_ID} model="codex-gpt-5.3-codex-high" onClearModel={onClearModel} />,
    );
    expect(onClearModel).toHaveBeenCalledTimes(1);
  });

  it('keeps a Claude id this build no longer lists on a Claude project', () => {
    querySnapshot.data = { type: 'claude-code' };
    const onClearModel = vi.fn();
    render(<Probe projectId={PROJECT_ID} model="opus-4.5" onClearModel={onClearModel} />);
    expect(onClearModel).not.toHaveBeenCalled();
  });

  it('keeps the saved id while the project provider is still unknown', () => {
    querySnapshot.data = { type: 'codex' };
    querySnapshot.isLoading = true;
    const onClearModel = vi.fn();
    render(<Probe projectId={PROJECT_ID} model="sonnet" onClearModel={onClearModel} />);
    expect(onClearModel).not.toHaveBeenCalled();
  });

  it('keeps a saved id whose provider prefix is hidden behind whitespace', () => {
    querySnapshot.data = { type: 'claude-code' };
    const onClearModel = vi.fn();
    render(
      <Probe
        projectId={PROJECT_ID}
        model=" codex-gpt-5.3-codex-high"
        onClearModel={onClearModel}
      />,
    );
    expect(onClearModel).not.toHaveBeenCalled();
  });
});
