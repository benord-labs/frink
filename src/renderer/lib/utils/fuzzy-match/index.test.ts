import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '.';

const NAMES = ['Fix sidebar search', 'Add billing page', 'Alpha', 'beta'];

function match(query: string, names: readonly string[] = NAMES): string[] {
  return fuzzyFilter(names, query, (name) => name);
}

describe('fuzzyFilter', () => {
  it('ignores case', () => {
    expect(match('SIDEBAR')).toEqual(['Fix sidebar search']);
  });

  it('matches words in any order', () => {
    expect(match('search sidebar')).toEqual(['Fix sidebar search']);
  });

  it('tolerates one typo per word', () => {
    expect(match('serach')).toEqual(['Fix sidebar search']);
    expect(match('sidebr serch')).toEqual(['Fix sidebar search']);
  });

  it('matches a partial word', () => {
    expect(match('side')).toEqual(['Fix sidebar search']);
  });

  it('keeps one- and two-letter words exact so short queries stay narrow', () => {
    expect(match('al')).toEqual(['Alpha']);
  });

  it('matches non-Latin names', () => {
    expect(match('проект', ['Новый проект', 'Fix sidebar search'])).toEqual(['Новый проект']);
  });

  it('returns nothing when no item matches', () => {
    expect(match('kubernetes')).toEqual([]);
  });

  it('keeps every item for a blank query', () => {
    expect(match('   ')).toEqual(NAMES);
  });

  it('returns nothing for a query with no letters or digits', () => {
    expect(match('!!!')).toEqual([]);
  });

  it('keeps the input order rather than ranking', () => {
    expect(match('a')).toEqual(['Fix sidebar search', 'Add billing page', 'Alpha', 'beta']);
  });
});
