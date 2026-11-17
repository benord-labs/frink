-- post_task_trigger polls every 2s for terminal tasks per project completed since a binding's
-- creation; this index lets SQLite seek (project_id, status IN …, completed_at >= …) instead of scanning.
CREATE INDEX `tasks_project_status_completed_idx` ON `tasks` (`project_id`,`status`,`completed_at`);
