/**
 * Refuse to boot the prebuilt QA rig bundle (`FRINK_QA_BUNDLE`) with an inherited `ELECTRON_RENDERER_URL`:
 * the window would silently render that dev server instead of out-qa. Keyed on the rig marker, not
 * `FRINK_CDP_PORT`, because an isolated `electron-vite dev` instance legitimately has both.
 */
export function assertRigRendererBundled(): void {
  if (!process.env.FRINK_QA_BUNDLE) return;
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!devServerUrl) return;
  throw new Error(
    `Refusing to boot: the QA rig bundle (FRINK_QA_BUNDLE) was handed ELECTRON_RENDERER_URL=${devServerUrl}, so it would load that dev server instead of its own out-qa renderer. Launch through scripts/qa/boot.sh, which scrubs the inherited dev env.`,
  );
}
