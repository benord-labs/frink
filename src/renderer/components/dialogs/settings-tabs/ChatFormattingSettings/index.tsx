import { type PrimitiveAtom, useAtom } from 'jotai';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Switch } from '@/components/ui/switch';
import { chatMarkdownAssistantAtom, chatMarkdownUserAtom } from '@/lib/atoms';

type FormattingRowProps = {
  label: string;
  description: string;
  atom: PrimitiveAtom<boolean>;
};

function FormattingRow({ label, description, atom }: FormattingRowProps) {
  const [enabled, setEnabled] = useAtom(atom);
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground leading-relaxed">{description}</span>
      </div>
      <Switch
        aria-label={label}
        checked={enabled}
        onCheckedChange={setEnabled}
        className="shrink-0"
      />
    </div>
  );
}

/** One switch per bubble role, matching the toggle on each message. */
export function ChatFormattingSettings() {
  return (
    <SettingsSection title="Chat">
      <SettingsCard>
        <div className="divide-y divide-border/60">
          <FormattingRow
            label="Format replies"
            description="Show headings, lists and code blocks in replies, in every chat. Turn off to see the plain text."
            atom={chatMarkdownAssistantAtom}
          />
          <FormattingRow
            label="Format your messages"
            description="Show headings, lists and code blocks in the messages you send. Off by default, so your text appears exactly as you typed it."
            atom={chatMarkdownUserAtom}
          />
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
