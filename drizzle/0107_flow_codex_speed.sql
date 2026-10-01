-- Flow settings and flow-task snapshots carry the Codex speed name instead of the Fast boolean.
-- Flows: true → 'fast', false/absent → absent (standard). Tasks: true → 'fast', false → 'standard'.
UPDATE `flow_versions` SET `graph` = json_set(json_remove(`graph`, '$.settings.codexFastMode'), '$.settings.codexSpeed', 'fast') WHERE json_valid(`graph`) AND json_extract(`graph`, '$.settings.codexFastMode') = 1;--> statement-breakpoint
UPDATE `flow_versions` SET `graph` = json_remove(`graph`, '$.settings.codexFastMode') WHERE json_valid(`graph`) AND json_type(`graph`, '$.settings.codexFastMode') IS NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `trigger_context` = json_set(json_remove(`trigger_context`, '$._config.codexFastMode'), '$._config.codexSpeed', CASE json_extract(`trigger_context`, '$._config.codexFastMode') WHEN 1 THEN 'fast' ELSE 'standard' END) WHERE json_valid(`trigger_context`) AND json_type(`trigger_context`, '$._config.codexFastMode') IN ('true', 'false');
