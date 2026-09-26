// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionFiltersSection } from './index';

function renderSection(field: string, value: string | string[] = '') {
  const onUpdateFilter = vi.fn();

  render(
    <ConditionFiltersSection
      filters={[{ id: 'f1', field, operator: 'equals', value }]}
      showFilters={true}
      availableFilterFields={[
        { id: 'repo_full_name', label: 'Repository' },
        { id: 'title', label: 'Title contains' },
      ]}
      onShowFiltersToggle={vi.fn()}
      onAddFilter={vi.fn()}
      onUpdateFilter={onUpdateFilter}
      onRemoveFilter={vi.fn()}
    />,
  );

  return { onUpdateFilter };
}

describe('ConditionFiltersSection value input', () => {
  it('renders the repository filter as a plain owner/repo text input', () => {
    const { onUpdateFilter } = renderSection('repo_full_name');

    fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
      target: { value: 'acme/api' },
    });

    expect(onUpdateFilter).toHaveBeenCalledWith('f1', { value: 'acme/api' });
  });

  it('hides the operator selector for the repository filter', () => {
    renderSection('repo_full_name');

    // Only the field selector renders; the operator is pinned to equals for this field.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('shows a stored list read-only, since there is no list editor', () => {
    renderSection('labels', ['bug', 'feature']);

    const input = screen.getByDisplayValue('bug, feature');
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute(
      'title',
      "This list can't be edited here. Remove the filter to change it.",
    );
  });

  it('shows the operator selector and a generic placeholder for other fields', () => {
    renderSection('title');

    expect(screen.getByPlaceholderText('Value...')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });
});
