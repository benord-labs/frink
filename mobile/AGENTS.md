# Mobile app: agent notes

- **Never run Metro on port 8081 from a worktree.** The owner's phone connects to 8081 by default and runs whatever that server serves. It must always be their main checkout. Preview worktree changes on another port (`bun run dev -- --port 8082`), tell the user the address, and stop that server when you finish.
- Don't stop a Metro server you didn't start without asking.
- Validate with `bun run check`, `bun run test` and `bun run test:ui` from this directory, and `bun run lint:structure` from the repository root.
- Don't branch on `composer.provider` or `account.type`. Have the Mac send the label or capability on `MobileComposer` (as `xhighSupported` does); the structure lint counts these branches and the count only goes down.
