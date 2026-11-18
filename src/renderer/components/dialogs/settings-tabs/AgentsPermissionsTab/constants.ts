export const PERMISSIONS_SUBTITLE = 'Rules for the files and commands the agent can use';

export const SYSTEM_DENIED_DESCRIPTION =
  "No rule can open these paths, not even a project's allow rule. It's a fixed list, not a sandbox: a search can still show lines from these files, and some file reads aren't checked against it.";

export const SYSTEM_DENIED_WHAT_THIS_MEANS =
  'remains readable and writable as a public template; the other paths are refused wherever Frink checks them.';
