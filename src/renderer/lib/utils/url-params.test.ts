// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { getUrlParam } from './url-params';

describe('getUrlParam', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('reads a param from the query string (dev windows)', () => {
    window.history.replaceState({}, '', '/?chat=abc123');
    expect(getUrlParam('chat')).toBe('abc123');
  });

  it('falls back to the hash params (packaged file:// load)', () => {
    window.history.replaceState({}, '', '/#chat=def456&windowId=win-1');
    expect(getUrlParam('chat')).toBe('def456');
    expect(getUrlParam('windowId')).toBe('win-1');
  });

  it('prefers the query string over the hash', () => {
    window.history.replaceState({}, '', '/?chat=fromSearch#chat=fromHash');
    expect(getUrlParam('chat')).toBe('fromSearch');
  });

  it('returns null when the param is in neither', () => {
    window.history.replaceState({}, '', '/?other=x');
    expect(getUrlParam('chat')).toBeNull();
  });
});
