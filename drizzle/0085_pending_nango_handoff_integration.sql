-- Persist the immutable Frink integration bound by a completed Nango callback.
-- This lets an interrupted local compensation retry by exact account without
-- retaining or exposing the raw Nango handle outside the encrypted handoff.

ALTER TABLE `pending_nango_handoffs` ADD `integration_id` text;
