DELETE FROM `tasks`
WHERE `source` = 'flow'
  AND CASE
    WHEN `flow_run_id` IS NULL THEN 1
    WHEN `result` IS NULL THEN 0
    WHEN NOT json_valid(`result`) THEN 1
    WHEN json_type(`result`) <> 'object' THEN 1
    WHEN json_extract(`result`, '$.chatId') IS NULL THEN 0
    WHEN EXISTS (
      SELECT 1
      FROM `chats`
      WHERE `chats`.`id` = json_extract(`tasks`.`result`, '$.chatId')
    ) THEN 0
    ELSE 1
  END = 1;

--> statement-breakpoint

DELETE FROM `tasks`
WHERE `result` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(`result`) THEN 1
    WHEN json_type(`result`) <> 'object' THEN 1
    ELSE 0
  END = 1;

--> statement-breakpoint

DELETE FROM `tasks`
WHERE `trigger_context` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(`trigger_context`) THEN 1
    WHEN json_type(`trigger_context`) <> 'object' THEN 1
    ELSE 0
  END = 1;

--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `tasks_result_object_insert`
BEFORE INSERT ON `tasks`
WHEN NEW.`result` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(NEW.`result`) THEN 1
    WHEN json_type(NEW.`result`) <> 'object' THEN 1
    ELSE 0
  END = 1
BEGIN
  SELECT RAISE(ABORT, 'task result must be a JSON object');
END;

--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `tasks_trigger_context_object_insert`
BEFORE INSERT ON `tasks`
WHEN NEW.`trigger_context` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(NEW.`trigger_context`) THEN 1
    WHEN json_type(NEW.`trigger_context`) <> 'object' THEN 1
    ELSE 0
  END = 1
BEGIN
  SELECT RAISE(ABORT, 'task trigger context must be a JSON object');
END;

--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `tasks_trigger_context_object_update`
BEFORE UPDATE OF `trigger_context` ON `tasks`
WHEN NEW.`trigger_context` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(NEW.`trigger_context`) THEN 1
    WHEN json_type(NEW.`trigger_context`) <> 'object' THEN 1
    ELSE 0
  END = 1
BEGIN
  SELECT RAISE(ABORT, 'task trigger context must be a JSON object');
END;

--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `tasks_result_object_update`
BEFORE UPDATE OF `result` ON `tasks`
WHEN NEW.`result` IS NOT NULL
  AND CASE
    WHEN NOT json_valid(NEW.`result`) THEN 1
    WHEN json_type(NEW.`result`) <> 'object' THEN 1
    ELSE 0
  END = 1
BEGIN
  SELECT RAISE(ABORT, 'task result must be a JSON object');
END;
