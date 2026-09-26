import { describe, expect, it } from 'vitest';
import {
  getActiveOverlayViewPolicy,
  type LayoutDestination,
  resolveLayoutDestination,
} from './active-overlay-view-policy';

type PolicyCase = {
  name: string;
  destination: LayoutDestination;
  isMobile: boolean;
  isSplitActive: boolean;
  sidebarOpen: boolean;
  filesSidebarOpen: boolean;
  isFlowEditorOpen: boolean;
  expected: ReturnType<typeof getActiveOverlayViewPolicy>;
};

const POLICY_CASES: PolicyCase[] = [
  {
    name: 'desktop chat with both sidebar destinations available',
    destination: 'chat',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: true,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: true,
      showFilesSidebar: true,
      showFileSearch: true,
    },
  },
  {
    name: 'desktop split chat with the unified sidebar closed spans the full width',
    destination: 'chat',
    isMobile: false,
    isSplitActive: true,
    sidebarOpen: false,
    filesSidebarOpen: true,
    isFlowEditorOpen: false,
    expected: {
      // Split view hides the Files sidebar, so nothing is visible to inset from.
      isMainPaneInset: false,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: true,
    },
  },
  {
    name: 'desktop single-pane chat stays inset from an open Files sidebar',
    destination: 'chat',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: false,
    filesSidebarOpen: true,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: true,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: true,
      showFileSearch: true,
    },
  },
  {
    name: 'mobile chat goes flush when the Files sidebar is closed',
    destination: 'chat',
    isMobile: true,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: true,
      showFileSearch: true,
    },
  },
  {
    name: 'mobile chat stays inset from the default-open Files sidebar',
    destination: 'chat',
    isMobile: true,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: true,
    isFlowEditorOpen: false,
    expected: {
      // Files renders on mobile, so the pane keeps its seam beside it rather than going flush.
      isMainPaneInset: true,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: true,
      showFileSearch: true,
    },
  },
  {
    name: 'desktop Work Queue with the unified sidebar open',
    destination: 'workqueue',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: true,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: true,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'desktop Work Queue goes flush when the unified sidebar is closed',
    destination: 'workqueue',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: false,
    filesSidebarOpen: true,
    isFlowEditorOpen: false,
    expected: {
      // The Files sidebar never renders here, so its open flag cannot inset the pane.
      isMainPaneInset: false,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'mobile Work Queue is full-screen',
    destination: 'workqueue',
    isMobile: true,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'Settings owns its nested sidebar layout',
    destination: 'settings',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'Flows dashboard retains the unified sidebar like desktop Work Queue',
    destination: 'flows',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      // Same page surface as Work Queue, so the pane insets away from the sidebar identically.
      isMainPaneInset: true,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: true,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'Flows dashboard keeps the sidebar toggleable while it is collapsed',
    destination: 'flows',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: false,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: true,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'Flow editor is a full-width takeover with no sidebar',
    destination: 'flows',
    isMobile: false,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: true,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
  {
    name: 'mobile Flows dashboard stays full-screen',
    destination: 'flows',
    isMobile: true,
    isSplitActive: false,
    sidebarOpen: true,
    filesSidebarOpen: false,
    isFlowEditorOpen: false,
    expected: {
      isMainPaneInset: false,
      canToggleUnifiedSidebar: false,
      isUnifiedSidebarOpen: false,
      showFilesSidebar: false,
      showFileSearch: false,
    },
  },
];

describe('getActiveOverlayViewPolicy', () => {
  it.each(POLICY_CASES)('$name', ({ expected, name: _name, ...options }) => {
    expect(getActiveOverlayViewPolicy(options)).toEqual(expected);
  });
});

describe('resolveLayoutDestination', () => {
  it.each([
    [null, 'chat'],
    ['settings', 'settings'],
    ['flows', 'flows'],
    ['workqueue', 'workqueue'],
  ] as const)('maps %s to %s', (overlay, expected) => {
    expect(resolveLayoutDestination(overlay)).toBe(expected);
  });
});
