-- Every resume now continues a session that already answered its step, so a resume intent carries no
-- `continuation` flag; strip it from intents queued before that change so the strict reader accepts them.
UPDATE `flow_run_admissions` SET `intent_json` = json_remove(`intent_json`, '$.continuation') WHERE json_valid(`intent_json`) AND json_type(`intent_json`, '$.continuation') IS NOT NULL;
