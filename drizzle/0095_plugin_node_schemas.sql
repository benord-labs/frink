-- The tool schema each curated plugin Flow action was probed with, keyed by catalog action.
-- Node existence derives from connection state; this table only shapes a node's form.

CREATE TABLE IF NOT EXISTS `plugin_node_schemas` (
	`plugin_id` text NOT NULL,
	`action_id` text NOT NULL,
	`inputs` text NOT NULL,
	`unsupported_fields` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `action_id`)
);
