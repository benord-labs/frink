/** Native modules dictation needs; a build made before they were added lacks them. */
export const DICTATION_MODULES = ['ExpoSpeechRecognition'];
/** Hands-free voice also reads replies aloud and keeps the screen on while it runs. */
export const VOICE_MODE_MODULES = [...DICTATION_MODULES, 'ExpoSpeech', 'ExpoKeepAwake'];

/** A voice feature works only on a native build holding every module it needs. `find` must look a
 *  module up without loading its package: those packages throw on import when it is missing. */
export function voiceAvailable<M>(
  modules: string[],
  os: string,
  find: (name: string) => M | null,
): boolean {
  return os !== 'web' && modules.every((name) => find(name) !== null);
}
