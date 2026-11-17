import type { SDKModel } from '@cursor/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../db';
import { freshDb } from '../../db/test-utils/fresh-db';
import { rememberedAgentModels } from '../agent-models';
import { cursorModelFor, cursorModelRows, saveCursorModels } from './cursor-models';

// Entries from a recorded Cursor.models.list() (SDK 1.0.36), each keeping only its default variant.
const RECORDED: SDKModel[] = [
  {
    id: 'default',
    displayName: 'Auto',
    aliases: ['auto'],
    variants: [{ params: [], displayName: 'Auto', isDefault: true }],
  },
  {
    id: 'grok-4.7',
    displayName: 'Grok 4.7',
    parameters: [
      { id: 'context', values: [{ value: '256k' }, { value: '500k' }] },
      {
        id: 'reasoning_effort',
        displayName: 'Effort',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
    variants: [
      {
        params: [
          { id: 'context', value: '500k' },
          { id: 'reasoning_effort', value: 'high' },
          { id: 'fast', value: 'true' },
        ],
        displayName: 'Grok 4.7  High Fast',
        isDefault: true,
      },
    ],
  },
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
    variants: [
      { params: [{ id: 'fast', value: 'true' }], displayName: 'Composer 2.5', isDefault: true },
    ],
  },
  {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    parameters: [
      {
        id: 'effort',
        values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value })),
      },
    ],
    variants: [
      {
        params: [
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'medium' },
        ],
        displayName: 'Claude Opus 5.5',
        isDefault: true,
      },
    ],
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    parameters: [
      {
        id: 'reasoning',
        values: ['none', 'low', 'medium', 'high', 'extra-high'].map((value) => ({ value })),
      },
    ],
    variants: [
      { params: [{ id: 'reasoning', value: 'medium' }], displayName: 'GPT-5.5', isDefault: true },
    ],
  },
  {
    id: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    variants: [{ params: [], displayName: 'Gemini 3.1 Pro', isDefault: true }],
  },
];

const opus = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', detail: string) => ({
  id: `claude-opus-5-5/${effort}`,
  name: 'Claude Opus 5.5',
  familyId: 'claude-opus-5-5',
  effort,
  detail,
  params: [{ id: 'effort', value: effort }],
});

describe('cursorModelRows', () => {
  it('gives one row per model, and one per effort where the model offers a choice', () => {
    const rows = cursorModelRows(RECORDED);

    expect(rows.map((row) => row.id)).toEqual([
      'default',
      'grok-4.7/low',
      'grok-4.7/medium',
      'grok-4.7/high',
      'grok-4.7/xhigh',
      'composer-2.5',
      'claude-opus-5-5/low',
      'claude-opus-5-5/medium',
      'claude-opus-5-5/high',
      'claude-opus-5-5/xhigh',
      'claude-opus-5-5/max',
      'gpt-5.5/low',
      'gpt-5.5/medium',
      'gpt-5.5/high',
      'gemini-3.1-pro',
    ]);
    expect(rows.filter((row) => row.familyId === 'claude-opus-5-5')).toEqual([
      opus('low', 'Low'),
      { ...opus('medium', 'Medium'), effortDefault: true },
      opus('high', 'High'),
      opus('xhigh', 'Extra High'),
      opus('max', 'Max'),
    ]);
    expect(rows.find((row) => row.id === 'grok-4.7/high')).toMatchObject({
      effortDefault: true,
      params: [{ id: 'reasoning_effort', value: 'high' }],
    });
    expect(rows.find((row) => row.id === 'gpt-5.5/low')?.params).toEqual([
      { id: 'reasoning', value: 'low' },
    ]);
    expect(rows[0]).toEqual({ id: 'default', name: 'Auto' });
    expect(rows.find((row) => row.id === 'composer-2.5')).toEqual({
      id: 'composer-2.5',
      name: 'Composer 2.5',
    });
  });

  it('puts Auto first wherever Cursor lists it', () => {
    expect(cursorModelRows([...RECORDED].reverse())[0]).toEqual({ id: 'default', name: 'Auto' });
  });

  it('gives a model whose effort values Frink has no name for one row', () => {
    const odd: SDKModel = {
      id: 'odd-1',
      displayName: 'Odd 1',
      parameters: [{ id: 'effort', values: [{ value: 'turbo' }, { value: 'extra-high' }] }],
    };
    expect(cursorModelRows([odd])).toEqual([{ id: 'odd-1', name: 'Odd 1' }]);
  });
});

describe('saved Cursor models', () => {
  beforeEach(() => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(freshDb());
  });

  it('keeps the rows Cursor last listed, for the picker after a restart', () => {
    saveCursorModels(RECORDED);
    expect(rememberedAgentModels('cursor')).toEqual(cursorModelRows(RECORDED));
  });
});

describe('cursorModelFor', () => {
  const rows = cursorModelRows(RECORDED);

  it('sends the saved model and only its effort, as listed', () => {
    expect(cursorModelFor(rows, 'grok-4.7/xhigh')).toEqual({
      model: { id: 'grok-4.7', params: [{ id: 'reasoning_effort', value: 'xhigh' }] },
    });
    expect(cursorModelFor(rows, 'claude-opus-5-5')).toEqual({
      model: { id: 'claude-opus-5-5', params: [{ id: 'effort', value: 'medium' }] },
    });
    expect(cursorModelFor(rows, 'composer-2.5')).toEqual({ model: { id: 'composer-2.5' } });
    expect(cursorModelFor(rows, 'default')).toEqual({ model: { id: 'default' } });
  });

  it("refuses a model Cursor no longer lists, and keeps Cursor's default without a list or a pick", () => {
    expect(cursorModelFor(rows, 'grok-3/high')).toEqual({
      refusal: 'Cursor no longer offers grok-3. Pick another model.',
    });
    expect(cursorModelFor([], 'grok-3/high')).toEqual({});
    expect(cursorModelFor(rows, undefined)).toEqual({});
  });
});
