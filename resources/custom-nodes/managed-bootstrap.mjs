// fallow-ignore-file unused-file
// electron-builder packages this runtime entrypoint via extraResources.
import { pathToFileURL } from 'node:url';

function flush(stream) {
  return new Promise((resolve) => {
    stream.write('', resolve);
  });
}

async function flushOutput() {
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
}

const [runtimeExecutable, , entrypoint, ...entrypointArgs] = process.argv;

if (!entrypoint) {
  console.error('Frink custom-node bootstrap requires an entrypoint path.');
  await flushOutput();
  process.exit(1);
}

// Preserve the direct-script argv contract for the imported custom node.
process.argv = [runtimeExecutable ?? process.execPath, entrypoint, ...entrypointArgs];

try {
  await import(pathToFileURL(entrypoint).href);
  const exitCode = process.exitCode ?? 0;
  await flushOutput();
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await flushOutput();
  process.exit(1);
}
