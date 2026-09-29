// Grandfather list for the renderer import walls
// (project-structure/independent-modules). One module entry per file that
// predates the walls, widened with the MINIMAL extra allowances it needs.
//
// Shrink-only: fix a file's imports (types -> src/shared/types, deep feature
// paths -> barrels, frozen dirs -> lib/) and remove its entry. Never add an
// entry; nothing regenerates this list.

export const rendererImportWallBaseline = [
  {
    "name": "grandfather:src/renderer/App.tsx",
    "pattern": "src/renderer/App.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/contexts/**",
      "src/renderer/features/agents/**",
      "src/renderer/features/layout/**",
      "src/renderer/features/provider-config/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/agents-debug-tab.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/agents-debug-tab.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/AgentsModelsTab/AccountsList/index.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/AgentsModelsTab/AccountsList/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/AgentsSkillsTab/index.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/AgentsSkillsTab/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/types/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/ProjectAiAccountSelector/index.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/ProjectAiAccountSelector/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/ResourceSettingsTab/index.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/ResourceSettingsTab/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/types/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/dialogs/settings-tabs/ResourceSettingsTab/ResourceRow.tsx",
    "pattern": "src/renderer/components/dialogs/settings-tabs/ResourceSettingsTab/ResourceRow.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/types/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/FloatingBadge.tsx",
    "pattern": "src/renderer/components/FloatingBadge.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/components/Mascot/index.tsx",
    "pattern": "src/renderer/components/Mascot/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/atoms/index.ts",
    "pattern": "src/renderer/features/agents/atoms/index.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/components/new-chat-form-header.tsx",
    "pattern": "src/renderer/features/agents/components/new-chat-form-header.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/terminal/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/components/queue-processor.tsx",
    "pattern": "src/renderer/features/agents/components/queue-processor.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/hooks/use-file-tree-toggle.ts",
    "pattern": "src/renderer/features/agents/hooks/use-file-tree-toggle.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/lib/create-agent-chat.ts",
    "pattern": "src/renderer/features/agents/lib/create-agent-chat.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/lib/sentinel-cleanup.ts",
    "pattern": "src/renderer/features/agents/lib/sentinel-cleanup.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/terminal/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/lib/websocket-chat-transport.ts",
    "pattern": "src/renderer/features/agents/lib/websocket-chat-transport.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/main/**",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat.tsx",
    "pattern": "src/renderer/features/agents/main/active-chat.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/sidebar/**",
      "src/renderer/features/terminal/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/components/CommitFileItem.tsx",
    "pattern": "src/renderer/features/agents/main/active-chat/components/CommitFileItem.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/changes/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/components/DiffSidebarContent.tsx",
    "pattern": "src/renderer/features/agents/main/active-chat/components/DiffSidebarContent.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/changes/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/components/DiffSidebarRenderer.tsx",
    "pattern": "src/renderer/features/agents/main/active-chat/components/DiffSidebarRenderer.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/changes/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/components/SidebarsSection.tsx",
    "pattern": "src/renderer/features/agents/main/active-chat/components/SidebarsSection.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/terminal/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/hooks/useGitOperations.ts",
    "pattern": "src/renderer/features/agents/main/active-chat/hooks/useGitOperations.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/main/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/hooks/useMessageSend.ts",
    "pattern": "src/renderer/features/agents/main/active-chat/hooks/useMessageSend.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/contexts/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/active-chat/hooks/usePlanApproval.ts",
    "pattern": "src/renderer/features/agents/main/active-chat/hooks/usePlanApproval.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/main/new-chat-form.tsx",
    "pattern": "src/renderer/features/agents/main/new-chat-form.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/terminal/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/stores/sub-chat-store.ts",
    "pattern": "src/renderer/features/agents/stores/sub-chat-store.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/contexts/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/account-indicator.tsx",
    "pattern": "src/renderer/features/agents/ui/account-indicator.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/agent-file-item.tsx",
    "pattern": "src/renderer/features/agents/ui/agent-file-item.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/file-viewer/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/AgentFlowTool/index.tsx",
    "pattern": "src/renderer/features/agents/ui/AgentFlowTool/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/flows/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/agents-content.tsx",
    "pattern": "src/renderer/features/agents/ui/agents-content.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/split-pane-project-info.ts",
    "pattern": "src/renderer/features/agents/ui/split-pane-project-info.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/split-view-container/index.tsx",
    "pattern": "src/renderer/features/agents/ui/split-view-container/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/split-view-container/SplitPane.tsx",
    "pattern": "src/renderer/features/agents/ui/split-view-container/SplitPane.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/split-view-container/SplitPaneFileTreeSidebar.tsx",
    "pattern": "src/renderer/features/agents/ui/split-view-container/SplitPaneFileTreeSidebar.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/agents/ui/trigger-bubble.tsx",
    "pattern": "src/renderer/features/agents/ui/trigger-bubble.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/work-queue/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/changes/ChangesView/index.tsx",
    "pattern": "src/renderer/features/changes/ChangesView/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/changes/components/diff-sidebar-header/diff-sidebar-header.tsx",
    "pattern": "src/renderer/features/changes/components/diff-sidebar-header/diff-sidebar-header.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/changes/components/diff-sidebar-header/diff-view-mode-switcher.tsx",
    "pattern": "src/renderer/features/changes/components/diff-sidebar-header/diff-view-mode-switcher.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/changes/components/file-list-item.tsx",
    "pattern": "src/renderer/features/changes/components/file-list-item.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/file-viewer/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/code-editor/CodeEditorPanel/index.tsx",
    "pattern": "src/renderer/features/code-editor/CodeEditorPanel/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/file-viewer/components/file-search-dialog.tsx",
    "pattern": "src/renderer/features/file-viewer/components/file-search-dialog.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/file-viewer/components/use-dialog-search-state.ts",
    "pattern": "src/renderer/features/file-viewer/components/use-dialog-search-state.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/chrome.ts",
    "pattern": "src/renderer/features/files-sidebar/chrome.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/FileTree/index.tsx",
    "pattern": "src/renderer/features/files-sidebar/FileTree/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/FileTree/InlineInput.tsx",
    "pattern": "src/renderer/features/files-sidebar/FileTree/InlineInput.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/FileTree/TreeNode.tsx",
    "pattern": "src/renderer/features/files-sidebar/FileTree/TreeNode.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/changes/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/index.tsx",
    "pattern": "src/renderer/features/files-sidebar/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/PaneFileTree.tsx",
    "pattern": "src/renderer/features/files-sidebar/PaneFileTree.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/files-sidebar/utils/content-search-actions.ts",
    "pattern": "src/renderer/features/files-sidebar/utils/content-search-actions.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/layout/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/AgentConfig/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/AgentConfig/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/FlowProjectField/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/FlowProjectField/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/NodeModelField/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/NodeModelField/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/NodeProjectField/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/NodeProjectField/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/StartTaskConfig/FlowBranchField/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/StartTaskConfig/FlowBranchField/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/BlockConfig/WebhookTriggerConfig/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/BlockConfig/WebhookTriggerConfig/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/integrations/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/FlowSettingsPanel/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/FlowSettingsPanel/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/hooks/flow-picker-models.ts",
    "pattern": "src/renderer/features/flows/FlowEditor/hooks/flow-picker-models.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**",
      "src/renderer/utils/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowEditor/NodeCreatorPanel/index.tsx",
    "pattern": "src/renderer/features/flows/FlowEditor/NodeCreatorPanel/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowsList/index.tsx",
    "pattern": "src/renderer/features/flows/FlowsList/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/main/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/flows/FlowsPage/index.tsx",
    "pattern": "src/renderer/features/flows/FlowsPage/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/layout/agents-layout.tsx",
    "pattern": "src/renderer/features/layout/agents-layout.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/file-viewer/**",
      "src/renderer/features/files-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/settings/SettingsPage/index.tsx",
    "pattern": "src/renderer/features/settings/SettingsPage/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/components/ChatListItem.tsx",
    "pattern": "src/renderer/features/sidebar/unified/components/ChatListItem.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/components/QuickActions/index.tsx",
    "pattern": "src/renderer/features/sidebar/unified/components/QuickActions/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/components/SidebarDialogs/index.tsx",
    "pattern": "src/renderer/features/sidebar/unified/components/SidebarDialogs/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/work-queue/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/hooks/use-sidebar-chat-cache.ts",
    "pattern": "src/renderer/features/sidebar/unified/hooks/use-sidebar-chat-cache.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/main/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/hooks/use-task-aware-chat-actions.ts",
    "pattern": "src/renderer/features/sidebar/unified/hooks/use-task-aware-chat-actions.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/types.ts",
    "pattern": "src/renderer/features/sidebar/unified/types.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/preload/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/sidebar/unified/UnifiedSidebar.tsx",
    "pattern": "src/renderer/features/sidebar/unified/UnifiedSidebar.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/terminal/terminal-mode-switcher.tsx",
    "pattern": "src/renderer/features/terminal/terminal-mode-switcher.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/terminal/terminal-sidebar.tsx",
    "pattern": "src/renderer/features/terminal/terminal-sidebar.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/terminal/terminal-tabs.tsx",
    "pattern": "src/renderer/features/terminal/terminal-tabs.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/terminal/use-terminal-manager.ts",
    "pattern": "src/renderer/features/terminal/use-terminal-manager.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/features/work-queue/WorkQueue/index.tsx",
    "pattern": "src/renderer/features/work-queue/WorkQueue/index.tsx",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/details-sidebar/**",
      "src/renderer/features/sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-chat-markdown-toggle.ts",
    "pattern": "src/renderer/hooks/use-chat-markdown-toggle.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-flow-canvas-execution.ts",
    "pattern": "src/renderer/hooks/use-flow-canvas-execution.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/flows/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-ide-config-watcher.ts",
    "pattern": "src/renderer/hooks/use-ide-config-watcher.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/constants/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-mark-task-complete.ts",
    "pattern": "src/renderer/hooks/use-mark-task-complete.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-sub-chat-mode-sync.ts",
    "pattern": "src/renderer/hooks/use-sub-chat-mode-sync.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/use-validated-project.ts",
    "pattern": "src/renderer/hooks/use-validated-project.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/hooks/usePRStatus/usePRStatus.ts",
    "pattern": "src/renderer/hooks/usePRStatus/usePRStatus.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/main/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/lib/atoms/index.ts",
    "pattern": "src/renderer/lib/atoms/index.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/lib/code-editor/state/atoms.ts",
    "pattern": "src/renderer/lib/code-editor/state/atoms.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/features/agents/**",
      "src/renderer/features/files-sidebar/**"
    ]
  },
  {
    "name": "grandfather:src/renderer/lib/window-storage.ts",
    "pattern": "src/renderer/lib/window-storage.ts",
    "allowImportsFrom": [
      "{renderer_base}",
      "src/renderer/contexts/**"
    ]
  },
];
