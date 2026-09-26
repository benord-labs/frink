-- Keep reconnect callback identity machine-sealed so an ambiguous trusted-server
-- response can be retried after restart without exposing raw Nango handles.

ALTER TABLE `pending_nango_handoffs` ADD `reconnect_integration_id` text;
--> statement-breakpoint
ALTER TABLE `pending_nango_handoffs` ADD `reconnect_expected_connection_hash` text;
--> statement-breakpoint
ALTER TABLE `pending_nango_handoffs` ADD `reconnect_expected_connection_id_encrypted` text;
--> statement-breakpoint
CREATE TRIGGER `pending_nango_handoffs_reconnect_context_insert_check`
BEFORE INSERT ON `pending_nango_handoffs`
WHEN NOT (
  (`NEW`.`reconnect_integration_id` IS NULL
    AND `NEW`.`reconnect_expected_connection_hash` IS NULL
    AND `NEW`.`reconnect_expected_connection_id_encrypted` IS NULL)
  OR
  (`NEW`.`reconnect_integration_id` IS NOT NULL
    AND `NEW`.`reconnect_expected_connection_hash` IS NOT NULL
    AND `NEW`.`reconnect_expected_connection_id_encrypted` IS NOT NULL
    AND length(`NEW`.`reconnect_integration_id`) > 0
    AND length(`NEW`.`reconnect_expected_connection_hash`) = 64
    AND length(`NEW`.`reconnect_expected_connection_id_encrypted`) > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid pending Nango reconnect context');
END;
--> statement-breakpoint
CREATE TRIGGER `pending_nango_handoffs_reconnect_context_update_check`
BEFORE UPDATE OF `reconnect_integration_id`, `reconnect_expected_connection_hash`, `reconnect_expected_connection_id_encrypted`
ON `pending_nango_handoffs`
WHEN NOT (
  (`NEW`.`reconnect_integration_id` IS NULL
    AND `NEW`.`reconnect_expected_connection_hash` IS NULL
    AND `NEW`.`reconnect_expected_connection_id_encrypted` IS NULL)
  OR
  (`NEW`.`reconnect_integration_id` IS NOT NULL
    AND `NEW`.`reconnect_expected_connection_hash` IS NOT NULL
    AND `NEW`.`reconnect_expected_connection_id_encrypted` IS NOT NULL
    AND length(`NEW`.`reconnect_integration_id`) > 0
    AND length(`NEW`.`reconnect_expected_connection_hash`) = 64
    AND length(`NEW`.`reconnect_expected_connection_id_encrypted`) > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid pending Nango reconnect context');
END;
