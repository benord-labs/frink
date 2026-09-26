import type { ReactElement, ReactNode } from 'react';

type Props = {
  title: string;
  /** One plain line under the title saying what the section is for. */
  description?: string;
  children: ReactNode;
};

/** The one section heading in Settings: a title over the section's card or list. */
export function SettingsSection({ title, description, children }: Props): ReactElement {
  return (
    <section aria-label={title} className="space-y-3">
      <div>
        <h3 className="font-semibold text-base text-foreground">{title}</h3>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
