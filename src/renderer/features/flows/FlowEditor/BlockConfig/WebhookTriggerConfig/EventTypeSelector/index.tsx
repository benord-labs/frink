/**
 * EventTypeSelector Component
 * Step 1: Select the event that will trigger this rule
 */

import { Zap } from 'lucide-react';
import { memo } from 'react';
import { Label } from '../../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../../components/ui/select';
import type { EventType } from '../../../../../../lib/flows/webhook-trigger/types';

type Props = {
  eventType: string;
  eventTypes: readonly EventType[] | undefined;
  onEventTypeChange: (value: string) => void;
};

export const EventTypeSelector = memo(({ eventType, eventTypes, onEventTypeChange }: Props) => {
  // A saved event can be dropped from the provider's list. Without a matching option the
  // control renders blank, which reads as lost data — so name the stored event and disable it.
  const removed =
    eventType !== '' && eventTypes !== undefined && !eventTypes.some((e) => e.id === eventType);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
          1
        </div>
        <Label className="text-sm font-medium">When this happens</Label>
      </div>
      <Select value={eventType} onValueChange={onEventTypeChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select an event..." />
        </SelectTrigger>
        <SelectContent>
          {removed ? (
            <SelectItem value={eventType} disabled>
              {eventType} (no longer available)
            </SelectItem>
          ) : null}
          {eventTypes?.map((event) => (
            <SelectItem key={event.id} value={event.id}>
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                {event.label}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
});

EventTypeSelector.displayName = 'EventTypeSelector';
