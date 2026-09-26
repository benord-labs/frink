-- The hosted OAuth broker is gone, so the tables that parked a half-finished browser handoff have
-- nothing left to park. Dropping them is safe: no code reads or writes either one.
DROP TABLE IF EXISTS `pending_nango_reconnect_intents`;--> statement-breakpoint
DROP TABLE IF EXISTS `pending_nango_handoffs`;
