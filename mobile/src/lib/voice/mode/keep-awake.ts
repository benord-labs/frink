/** One keep-awake switch, as the package gives it: async, though a stand-in may return nothing. */
type Switch = (tag: string) => Promise<void> | void;
/** The two keep-awake functions used here, named as the package names them. */
export type KeepAwake = { activateKeepAwakeAsync: Switch; deactivateKeepAwake: Switch };

/** Keeps the screen on or lets it sleep, in call order. A failure to load, a throw or a rejection
 *  only means the screen may sleep, so each is let go. */
export function switchAwake(on: boolean, tag: string, load: () => KeepAwake): void {
  void Promise.resolve()
    .then(() => {
      const awake = load();
      return on ? awake.activateKeepAwakeAsync(tag) : awake.deactivateKeepAwake(tag);
    })
    .catch(() => undefined);
}
