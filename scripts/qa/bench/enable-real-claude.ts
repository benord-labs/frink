// Stamps the seeded claude-passthrough row to use the machine's Claude Code keychain entry (real quota); run after seed.sh, reload the renderer if the app is already up.
import { Database } from 'bun:sqlite';

const DEFAULT_DB = `${process.env.HOME}/Library/Application Support/Frink Dev-21399/data/agents.db`;
const dbPath = process.argv[2] ?? DEFAULT_DB;
const db = new Database(dbPath);
db.run(
  "update claude_code_credentials set source_path = 'darwin-keychain://Claude%20Code-credentials', needs_reauth_at = NULL",
);
console.log(JSON.stringify(db.query('select id, source_path, needs_reauth_at from claude_code_credentials').all()));
db.close();
