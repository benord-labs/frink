/** Which Claude settings file defined a registration. */
export type HookScope = 'user' | 'project' | 'local';

/** `detail` is a plain sentence that names the hook. */
export type HookRefusal = {
  code:
    | 'malformed'
    | 'handler-type'
    | 'event-unsupported'
    | 'provider-variable'
    | 'async'
    | 'field-unsupported'
    | 'field-unknown';
  detail: string;
};

/** A supported hook runs as written; `ignored` lists fields that change nothing it decides. */
export type HookBinding =
  | { status: 'supported'; ignored: { field: string; reason: string }[] }
  | { status: 'refused'; refusals: HookRefusal[] };

/** One handler under one matcher group, as written, plus whether Frink can bind it. */
export type HookRegistration = {
  /** `<scope>:<event>:<group index>:<handler index>`, its place in the file. */
  id: string;
  scope: HookScope;
  file: string;
  event: string;
  /** As written; absent and '' stay distinct. */
  matcher?: string;
  handlerType: string;
  /** Short name for messages: script file name, program name, or 'inline shell script'. */
  label: string;
  command?: string;
  /** Exec form: `command` is the program and these are its arguments, with no shell. */
  args?: string[];
  /** A permission rule, as written: the hook runs only for a tool call that matches it. */
  if?: string;
  timeoutSec?: number;
  binding: HookBinding;
};

export type HookSource = {
  scope: HookScope;
  file: string;
  status: 'read' | 'missing' | 'invalid';
  detail?: string;
};

/** The settings-file hook registrations of one project; other hook sources are not read. */
export type HookInventory = {
  /** The root checkout of a Frink-managed worktree; any other path as given. */
  rootPath: string;
  sources: HookSource[];
  /** The last of user, project, local that sets it; false while any source is invalid. */
  disableAllHooks: boolean;
  registrations: HookRegistration[];
};
