import type { ChildProcess } from 'node:child_process';
import type { MessageWriter } from 'vscode-jsonrpc/node';

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'css'
  | 'scss'
  | 'sass'
  | 'less'
  | 'html'
  | 'json'
  | 'jsonc';

export type LanguageServerInfo = {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
};

export type LanguageServerInstance = {
  process: ChildProcess;
  workspacePath: string;
  language: LanguageId;
  pid: number | undefined;
  startTime: number;
  isRunning: boolean;
  writer?: MessageWriter;
};

export type StartServerParams = {
  workspacePath: string;
  language: LanguageId;
};

export type StopServerParams = {
  workspacePath: string;
  language: LanguageId;
};

export type ServerMessageParams = {
  workspacePath: string;
  language: LanguageId;
  message: string;
};
