import { describe, expect, it } from 'vitest';
import {
  getNextCodeEditorLayout,
  getNextCodeEditorLayoutFromUnknown,
  normalizeCodeEditorLayout,
} from './layout-cycle';

describe('layout-cycle', () => {
  describe('normalizeCodeEditorLayout', () => {
    it('maps legacy vertical to top', () => {
      expect(normalizeCodeEditorLayout('vertical')).toBe('top');
    });

    it('maps legacy horizontal to left', () => {
      expect(normalizeCodeEditorLayout('horizontal')).toBe('left');
    });

    it('keeps modern layouts unchanged', () => {
      expect(normalizeCodeEditorLayout('top')).toBe('top');
      expect(normalizeCodeEditorLayout('left')).toBe('left');
      expect(normalizeCodeEditorLayout('right')).toBe('right');
    });

    it('falls back to top for invalid values', () => {
      expect(normalizeCodeEditorLayout('invalid-layout')).toBe('top');
      expect(normalizeCodeEditorLayout('')).toBe('top');
      expect(normalizeCodeEditorLayout(undefined)).toBe('top');
      expect(normalizeCodeEditorLayout(null)).toBe('top');
    });
  });

  describe('getNextCodeEditorLayout', () => {
    it('cycles top -> left -> right -> top', () => {
      expect(getNextCodeEditorLayout('top')).toBe('left');
      expect(getNextCodeEditorLayout('left')).toBe('right');
      expect(getNextCodeEditorLayout('right')).toBe('top');
    });
  });

  describe('getNextCodeEditorLayoutFromUnknown', () => {
    it('supports cycle from legacy persisted values', () => {
      expect(getNextCodeEditorLayoutFromUnknown('vertical')).toBe('left');
      expect(getNextCodeEditorLayoutFromUnknown('horizontal')).toBe('right');
    });
  });
});
