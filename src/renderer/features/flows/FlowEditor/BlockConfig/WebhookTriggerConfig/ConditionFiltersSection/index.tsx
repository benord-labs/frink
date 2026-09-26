/**
 * ConditionFiltersSection Component
 * Configure optional condition filters for the rule
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { Filter, Plus, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { Label } from '../../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../../components/ui/select';
import {
  LONG_STRINGS,
  OPERATOR_OPTIONS,
} from '../../../../../../lib/flows/webhook-trigger/constants';
import type { ConditionFilter } from '../../../../../../lib/flows/webhook-trigger/types';

type Props = {
  filters: ConditionFilter[];
  showFilters: boolean;
  availableFilterFields: Array<{ id: string; label: string }>;
  onShowFiltersToggle: () => void;
  onAddFilter: () => void;
  onUpdateFilter: (id: string, updates: Partial<ConditionFilter>) => void;
  onRemoveFilter: (id: string) => void;
};

export const ConditionFiltersSection = memo(
  ({
    filters,
    showFilters,
    availableFilterFields,
    onShowFiltersToggle,
    onAddFilter,
    onUpdateFilter,
    onRemoveFilter,
  }: Props) => {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs font-medium">
              2
            </div>
            <Label className="text-sm font-medium">Conditions (optional)</Label>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onShowFiltersToggle}>
            <Filter className="h-3.5 w-3.5 mr-1" />
            {showFilters ? 'Hide' : 'Add filters'}
          </Button>
        </div>

        {showFilters && (
          <div className="space-y-3 p-4 rounded-lg border border-dashed border-border">
            {filters.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-2">
                {LONG_STRINGS.noConditionsText}
              </p>
            ) : (
              <div className="space-y-2">
                {filters.map((filter) => {
                  const isGithubRepositoryField = filter.field === 'repo_full_name';

                  return (
                    <div key={filter.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Select
                          value={filter.field}
                          onValueChange={(v) => onUpdateFilter(filter.id, { field: v })}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {availableFilterFields.map((f) => (
                              <SelectItem key={f.id} value={f.id}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {!isGithubRepositoryField ? (
                          <Select
                            value={filter.operator}
                            onValueChange={(v) =>
                              onUpdateFilter(filter.id, {
                                operator: v as ConditionFilter['operator'],
                              })
                            }
                          >
                            <SelectTrigger className="w-28">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {OPERATOR_OPTIONS.map((op) => (
                                <SelectItem key={op.value} value={op.value}>
                                  {op.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}

                        <Input
                          value={
                            Array.isArray(filter.value) ? filter.value.join(', ') : filter.value
                          }
                          // A stored list has no editor here; typing would save text the matcher cannot read.
                          readOnly={Array.isArray(filter.value)}
                          title={
                            Array.isArray(filter.value)
                              ? "This list can't be edited here. Remove the filter to change it."
                              : undefined
                          }
                          onChange={(e) => onUpdateFilter(filter.id, { value: e.target.value })}
                          placeholder={isGithubRepositoryField ? 'owner/repo' : 'Value...'}
                          className="flex-1"
                        />

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onRemoveFilter(filter.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <Button type="button" variant="secondary" size="sm" onClick={onAddFilter}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add filter
            </Button>
          </div>
        )}
      </div>
    );
  },
);

ConditionFiltersSection.displayName = 'ConditionFiltersSection';
