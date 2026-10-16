-- Start Task "wait" mode is gone: a task never started from it is cancelled and its live run gets Stop's writes
-- (startup admission recovery releases the slot); every stored task then drops the mode from its trigger context.
CREATE TEMP TABLE `wait_mode_runs` AS
SELECT DISTINCT `flow_run_id` AS `id` FROM `tasks`
WHERE `status` = 'pending'
  AND json_extract(`result`, '$.startMode') IS NULL
  AND lower(COALESCE(
    json_extract(`trigger_context`, '$._config.startMode'),
    json_extract(`trigger_context`, '$._config.start_mode'),
    json_extract(`trigger_context`, '$.Config.startMode'),
    json_extract(`trigger_context`, '$.Config.start_mode'),
    ''
  )) = 'wait'
  AND `flow_run_id` IN (SELECT `id` FROM `flow_runs` WHERE `status` IN ('pending', 'running', 'paused'));--> statement-breakpoint
UPDATE `flow_run_admissions` SET `state` = 'cancelled', `settled_at` = unixepoch()
WHERE `state` IN ('queued', 'claimed') AND `flow_run_id` IN (SELECT `id` FROM `wait_mode_runs`);--> statement-breakpoint
UPDATE `flow_runs` SET `status` = 'cancelled', `completed_at` = unixepoch()
WHERE `id` IN (SELECT `id` FROM `wait_mode_runs`);--> statement-breakpoint
UPDATE `node_runs` SET `status` = 'cancelled', `completed_at` = unixepoch()
WHERE `status` IN ('pending', 'running', 'awaiting_input', 'blocked')
  AND `flow_run_id` IN (SELECT `id` FROM `wait_mode_runs`);--> statement-breakpoint
UPDATE `tasks` SET
  `status` = 'cancelled',
  `completed_at` = unixepoch(),
  `result` = json_patch(coalesce(`result`, '{}'), '{"cancelled":true,"agentSignal":null,"heldQuestions":null}')
WHERE (`status` IN ('pending', 'running') AND `flow_run_id` IN (SELECT `id` FROM `wait_mode_runs`))
  OR (
    `status` = 'pending'
    AND json_extract(`result`, '$.startMode') IS NULL
    AND lower(COALESCE(
      json_extract(`trigger_context`, '$._config.startMode'),
      json_extract(`trigger_context`, '$._config.start_mode'),
      json_extract(`trigger_context`, '$.Config.startMode'),
      json_extract(`trigger_context`, '$.Config.start_mode'),
      ''
    )) = 'wait'
  );--> statement-breakpoint
UPDATE `tasks` SET `trigger_context` = json_remove(
  `trigger_context`, '$._config.startMode', '$._config.start_mode', '$.Config.startMode', '$.Config.start_mode'
)
WHERE lower(COALESCE(
  json_extract(`trigger_context`, '$._config.startMode'),
  json_extract(`trigger_context`, '$._config.start_mode'),
  json_extract(`trigger_context`, '$.Config.startMode'),
  json_extract(`trigger_context`, '$.Config.start_mode'),
  ''
)) = 'wait';--> statement-breakpoint
DROP TABLE `wait_mode_runs`;
