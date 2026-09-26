import { Badge } from '@benord-labs/frink-primitives';
import type { PluginStatus } from '../../../lib/plugins/plugin-view-model';

type Props = {
  status: PluginStatus;
};

export function PluginStatusBadge({ status }: Props) {
  return (
    <Badge variant={status.tone} data-plugin-status={status.id}>
      {status.label}
    </Badge>
  );
}
