/** Gate every lazy three.js scene on this, so the ~600KB chunk only loads where
 * WebGL works (an r3f-native fallback would load it anyway). */
export function hasWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
