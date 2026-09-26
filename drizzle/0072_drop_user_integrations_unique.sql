-- Drop the partial UNIQUE on (user, provider, COALESCE(workspace, user, identifier)).
-- Originally added as a backstop against duplicate OAuth re-auth rows (Gmail /
-- Slack / ClickUp). Those providers are gated cross-machine in 0.0.6 and never
-- write locally. For the two local providers (shortcut, github) the index
-- blocked the legitimate "connect the same account twice" UX — pre-0.0.5
-- cloud Postgres allowed it. Single-user-per-machine, fresh-wipe acceptable.

DROP INDEX IF EXISTS `user_integrations_user_provider_workspace_uq`;
