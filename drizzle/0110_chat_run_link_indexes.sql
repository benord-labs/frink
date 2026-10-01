-- A chat links to a flow run only through JSON (trigger context, node outputs, task result), so every
-- chat↔run lookup scanned every node_run. Each expression must match chatLinkId() in
-- src/main/lib/db/repos/task-queries/linked-flow-runs.ts exactly, or SQLite ignores the index.
CREATE INDEX `flow_runs_trigger_chat_idx` ON `flow_runs` ((CASE WHEN json_valid(`trigger_context`) THEN json_extract(`trigger_context`, '$.chatId') END));--> statement-breakpoint
CREATE INDEX `flow_runs_trigger_sub_chat_idx` ON `flow_runs` ((CASE WHEN json_valid(`trigger_context`) THEN json_extract(`trigger_context`, '$.subChatId') END));--> statement-breakpoint
CREATE INDEX `node_runs_output_chat_idx` ON `node_runs` ((CASE WHEN json_valid(`node_output`) THEN json_extract(`node_output`, '$.outputs.chatId') END));--> statement-breakpoint
CREATE INDEX `node_runs_output_sub_chat_idx` ON `node_runs` ((CASE WHEN json_valid(`node_output`) THEN json_extract(`node_output`, '$.outputs.subChatId') END));--> statement-breakpoint
CREATE INDEX `tasks_result_chat_idx` ON `tasks` ((CASE WHEN json_valid(`result`) THEN json_extract(`result`, '$.chatId') END));--> statement-breakpoint
CREATE INDEX `tasks_result_sub_chat_idx` ON `tasks` ((CASE WHEN json_valid(`result`) THEN json_extract(`result`, '$.subChatId') END));
