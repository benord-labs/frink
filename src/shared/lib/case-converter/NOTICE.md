# NOTICE

This folder contains code adapted from
[axios-case-converter](https://github.com/mpyw/axios-case-converter),
Copyright (c) 2017 mpyw, licensed under MIT. See `LICENSE`.

Modifications:

- Stripped axios / FormData / URLSearchParams / AxiosHeaders handling. tRPC
  IPC payloads are plain objects + arrays only.
- Inlined a small camel-case string fn (no external `camel-case` dep).
- Adapted as a tRPC v11 middleware (`createCaseConvertOutput`) instead of an
  axios interceptor stack.
- Replaced upstream's `Object.create(null)` clone target with `{}` so output
  objects inherit `Object.prototype` (renderer code calls `hasOwnProperty`,
  `toString`, etc. on tRPC results).
