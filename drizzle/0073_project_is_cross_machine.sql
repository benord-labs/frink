-- Permissions overhaul ticket 01: storage tier flag for permission rules.
-- false (0) → local sqlite only; true (1) → Neon mirror.
-- Promotion logic ships in ticket 07; UI toggle in ticket 11.
-- Existing rows default to single-machine (no silent cloud migration).

ALTER TABLE `projects` ADD `is_cross_machine` integer DEFAULT 0 NOT NULL;
