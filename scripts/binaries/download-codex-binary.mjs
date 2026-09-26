#!/usr/bin/env node

import { buildCodexFrink, releaseTargetKeys } from './build-codex-frink.mjs';

buildCodexFrink({ targetKeys: releaseTargetKeys() })
  .then((binaries) => console.log(`Built permission-aware Codex: ${binaries.join(', ')}`))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
