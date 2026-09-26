-- Batch from-beginning rerun: per-row re-dispatch mode so EVERY dispatch path (the initial
-- synchronous pass AND the event-driven slot-fill / successor-promotion that pick up overflow and
-- downstream runs) restarts a from-beginning rerun at its start_task. false (0) = resume-from-failure
-- (retry-failed / fresh start / default). MACHINE-LOCAL batch table — not synced to cloud.

ALTER TABLE `batch_stage_runs` ADD `rerun_from_beginning` integer DEFAULT 0 NOT NULL;
