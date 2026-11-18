-- A Flow's "Ask before running" setting holds its automatic runs: a held run is pending with held_at set and no
-- admission ticket. Flows saved with Start Task startMode "wait" move to the setting, in place.
ALTER TABLE `flow_runs` ADD `held_at` integer;--> statement-breakpoint
CREATE TEMP TABLE `wait_versions` AS
SELECT `id` FROM `flow_versions`
WHERE json_valid(`graph`) AND EXISTS (
  SELECT 1 FROM json_each(`graph`, '$.nodes') AS `n`
  WHERE json_extract(`n`.`value`, '$.blockType') = 'start_task'
    AND lower(json_extract(`n`.`value`, '$.config.startMode')) = 'wait'
);--> statement-breakpoint
UPDATE `flow_runs` SET `held_at` = coalesce(`created_at`, unixepoch())
WHERE `status` = 'pending' AND `started_at` IS NULL AND `batch_id` IS NULL
  AND `flow_version_id` IN (SELECT `id` FROM `wait_versions`)
  AND `id` IN (
    SELECT `flow_run_id` FROM `flow_run_admissions`
    WHERE `state` IN ('queued', 'claimed') AND `priority_class` = 'start'
  );--> statement-breakpoint
UPDATE `flow_run_admissions` SET `state` = 'cancelled', `settled_at` = unixepoch()
WHERE `state` IN ('queued', 'claimed')
  AND `flow_run_id` IN (SELECT `id` FROM `flow_runs` WHERE `held_at` IS NOT NULL);--> statement-breakpoint
UPDATE `node_runs` SET `node_output` = json_remove(`node_output`, '$.outputs.startMode')
WHERE `block_type` = 'start_task' AND json_valid(`node_output`)
  AND lower(json_extract(`node_output`, '$.outputs.startMode')) = 'wait';--> statement-breakpoint
UPDATE `flow_versions` SET `graph` = json_set(
  CASE WHEN json_type(`graph`, '$.settings') = 'object' THEN `graph`
    ELSE json_set(`graph`, '$.settings', json('{}')) END,
  '$.nodes', json((
    SELECT json_group_array(
      CASE WHEN json_extract(`n`.`value`, '$.blockType') = 'start_task'
          AND lower(json_extract(`n`.`value`, '$.config.startMode')) = 'wait'
        THEN json_remove(`n`.`value`, '$.config.startMode')
        ELSE json(`n`.`value`) END
      ORDER BY `n`.`key`
    )
    FROM json_each(`graph`, '$.nodes') AS `n`
  )),
  '$.settings.askBeforeRunning', json('true')
)
WHERE `id` IN (SELECT `id` FROM `wait_versions`);--> statement-breakpoint
DROP TABLE `wait_versions`;
