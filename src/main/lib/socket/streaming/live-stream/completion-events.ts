import { EventEmitter } from 'node:events';

export type SessionCompletion = { chatId: string; subChatId: string };
const events = new EventEmitter();
export function subscribeSessionCompletions(listener: (event: SessionCompletion) => void) {
  events.on('completed', listener);
  return () => {
    events.off('completed', listener);
  };
}
export function publishSessionCompletion(event: SessionCompletion): void {
  events.emit('completed', event);
}
