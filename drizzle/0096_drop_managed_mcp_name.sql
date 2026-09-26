-- Per-connection MCP provisioning is gone: every plugin connector is registered under its
-- catalog name (`plugin_<plugin>_<server>`), so a lifecycle row has no server name to carry.
ALTER TABLE `plugin_connection_lifecycles` DROP COLUMN `managed_mcp_name`;
