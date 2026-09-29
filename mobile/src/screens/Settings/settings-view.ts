export type MacStatus = {
  label: string;
  detail?: string;
  tone: 'live' | 'attention' | 'quiet';
};

/**
 * The connection in words. Status 0 means no answer at all (network); any other error means the
 * Mac answered but failed. Labels differ from the ResourceStatus banner above so they don't repeat.
 */
export function macStatus(overview: {
  data?: { executionReady: boolean };
  error?: string;
  errorStatus?: number;
}): MacStatus {
  if (overview.error && overview.errorStatus === 0)
    return {
      label: 'Offline',
      detail: 'Check Tailscale is on for both devices and your Mac is awake.',
      tone: 'quiet',
    };
  if (overview.error)
    return {
      label: 'Having trouble',
      detail: 'Frink on your Mac had a problem. Try again in a moment.',
      tone: 'attention',
    };
  if (!overview.data) return { label: 'Checking…', tone: 'quiet' };
  if (!overview.data.executionReady)
    return {
      label: 'Frink isn’t open on your Mac',
      detail: 'Open Frink on your Mac to run chats.',
      tone: 'attention',
    };
  return { label: 'Connected', tone: 'live' };
}

type CodeSource = { branch?: string; commit?: string; checkout?: string };

/** Checkout · branch · commit the running JavaScript came from, when the build recorded it. */
export function sourceLine(source: CodeSource | undefined): string | null {
  if (!source?.commit) return null;
  return [source.checkout, source.branch, source.commit].filter(Boolean).join(' · ');
}
