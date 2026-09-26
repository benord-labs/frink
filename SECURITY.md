# Security Policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories on
[`benord-labs/frink`](https://github.com/benord-labs/frink/security/advisories/new). Do not open a
public issue for a vulnerability. There is no bug bounty.

## Scope

The desktop app (`src/`) and the public relay (`relay/`). Frink Cloud lives in a separate private
repository and is not covered here.

## Two things to know first

- Execution is **unsandboxed**: custom nodes and command steps run as ordinary shell processes on
  the user's machine, by design.
- Webhook deliveries are verified **on the machine**, per provider signature, against the locally
  held endpoint secret — `src/shared/webhooks/receiver.ts`.
