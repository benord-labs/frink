/** Native modules the voice features need; a build made before they were added lacks them. */
export const VOICE_MODULES = ['ExpoSpeechRecognition'];

/** Voice works only on a native build that contains every voice module. `find` must look a module
 *  up without loading its package, because those packages throw on import when it is missing. */
export function voiceAvailable<M>(os: string, find: (name: string) => M | null): boolean {
  return os !== 'web' && VOICE_MODULES.every((name) => find(name) !== null);
}
