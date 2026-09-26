// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  activeOverlayAtom,
  agentsSettingsDialogOpenAtom,
  exitTransientDestinationForNavigationAtom,
  flowEditorOpenAtom,
  flowsDashboardActiveAtom,
  flowsSelectedFlowIdAtom,
  focusAgentChatAtom,
  selectedAgentChatIdAtom,
} from './agent-navigation-atoms';

/** The unified sidebar is the only surface rendered beside the Flows dashboard. */
const SIDEBAR = { flows: true } as const;

describe('agentsSettingsDialogOpenAtom', () => {
  it('restores Work Queue after Settings closes', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');

    store.set(agentsSettingsDialogOpenAtom, true);
    expect(store.get(activeOverlayAtom)).toBe('settings');

    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBe('workqueue');
  });

  it('preserves the Work Queue return across repeated open writes', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');

    store.set(agentsSettingsDialogOpenAtom, true);
    store.set(agentsSettingsDialogOpenAtom, true);
    store.set(agentsSettingsDialogOpenAtom, false);

    expect(store.get(activeOverlayAtom)).toBe('workqueue');
  });

  it('consumes the Work Queue return target when Settings navigates to a chat', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');
    store.set(agentsSettingsDialogOpenAtom, true);

    store.set(focusAgentChatAtom, 'chat-1');
    expect(store.get(activeOverlayAtom)).toBeNull();
    expect(store.get(selectedAgentChatIdAtom)).toBe('chat-1');

    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('consumes the Work Queue return target before a navigation hotkey', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');
    store.set(agentsSettingsDialogOpenAtom, true);

    expect(store.set(exitTransientDestinationForNavigationAtom)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();

    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('does not consume Settings opened from chat', () => {
    const store = createStore();
    store.set(activeOverlayAtom, null);
    store.set(agentsSettingsDialogOpenAtom, true);

    expect(store.set(exitTransientDestinationForNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('settings');
  });

  it('restores the Flows dashboard after Settings closes', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');

    store.set(agentsSettingsDialogOpenAtom, true);
    expect(store.get(activeOverlayAtom)).toBe('settings');

    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('leaves Settings opened from Flows standing for callers that cannot dismiss Flows', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(agentsSettingsDialogOpenAtom, true);

    expect(store.set(exitTransientDestinationForNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('settings');
  });

  it('consumes Settings opened from Flows for sidebar navigation', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(agentsSettingsDialogOpenAtom, true);

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();

    // The consumed return target must not resurface on a later close.
    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });
});

describe('exitTransientDestinationForNavigationAtom', () => {
  it('exits the Flows dashboard for sidebar navigation', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('leaves the Flows dashboard standing for callers that did not opt in', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');

    expect(store.set(exitTransientDestinationForNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('never dismisses the flow editor, even for sidebar navigation', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, 'flow-1');

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('exits Work Queue regardless of opt-in', () => {
    for (const scope of [undefined, SIDEBAR]) {
      const store = createStore();
      store.set(activeOverlayAtom, 'workqueue');

      expect(store.set(exitTransientDestinationForNavigationAtom, scope)).toBe(true);
      expect(store.get(activeOverlayAtom)).toBeNull();
    }
  });

  it('reports no-op when chat is already the visible destination', () => {
    const store = createStore();

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });
});

/**
 * FlowsPage branches on `!selectedFlowId`, while the layout policy and the sidebar each need the
 * same answer. Deriving both from one place keeps the rendered sub-view and the chrome that frames
 * it from disagreeing.
 */
describe('flows sub-state atoms', () => {
  it.each([
    ['no flow selected', null, true, false],
    ['a flow selected', 'flow-1', false, true],
  ] as const)('reports %s', (_label, flowId, dashboard, editor) => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, flowId);

    expect(store.get(flowsDashboardActiveAtom)).toBe(dashboard);
    expect(store.get(flowEditorOpenAtom)).toBe(editor);
  });

  /**
   * An empty id is not a flow. Matching FlowsPage's truthiness check keeps the sidebar from
   * collapsing for an editor that never rendered.
   */
  it('treats an empty flow id as no selection, like FlowsPage does', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, '');

    expect(store.get(flowsDashboardActiveAtom)).toBe(true);
    expect(store.get(flowEditorOpenAtom)).toBe(false);
  });

  it('lets sidebar navigation leave a dashboard reached with an empty flow id', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, '');

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it.each(['workqueue', 'settings', null] as const)('is false on the %s destination', (overlay) => {
    const store = createStore();
    store.set(activeOverlayAtom, overlay);
    store.set(flowsSelectedFlowIdAtom, 'flow-1');

    expect(store.get(flowsDashboardActiveAtom)).toBe(false);
    expect(store.get(flowEditorOpenAtom)).toBe(false);
  });

  /**
   * A flow left selected when the user navigated away means reopening Flows lands straight in the
   * editor. The sidebar must already be collapsed on that first frame, never flash open over it.
   */
  it('never reports the dashboard while a stale selection is restored', () => {
    const store = createStore();
    store.set(flowsSelectedFlowIdAtom, 'flow-1');
    const seen: boolean[] = [];
    const unsub = store.sub(flowsDashboardActiveAtom, () =>
      seen.push(store.get(flowsDashboardActiveAtom)),
    );

    store.set(activeOverlayAtom, 'flows');
    unsub();

    expect(store.get(flowEditorOpenAtom)).toBe(true);
    expect(seen).not.toContain(true);
  });
});

/**
 * The sidebar's Flows row writes activeOverlayAtom directly, bypassing the Settings facade, so a
 * Settings-return target recorded on the way in can outlive the destination it pointed at.
 */
describe('settings return target across a facade bypass', () => {
  const bypassToFlows = () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');
    store.set(agentsSettingsDialogOpenAtom, true);
    store.set(activeOverlayAtom, 'flows');
    return store;
  };

  it('does not resurrect Work Queue when leaving Flows for a chat', () => {
    const store = bypassToFlows();

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('keeps hotkeys on Flows despite the stale Work Queue return target', () => {
    const store = bypassToFlows();

    expect(store.set(exitTransientDestinationForNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('re-targets the return to Flows when Settings is reopened from there', () => {
    const store = bypassToFlows();

    store.set(agentsSettingsDialogOpenAtom, true);
    store.set(agentsSettingsDialogOpenAtom, false);

    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  /** Reopening Flows from the editor sub-state must not be dismissable by the sidebar. */
  it('refuses to dismiss Flows reopened straight into the editor', () => {
    const store = createStore();
    store.set(flowsSelectedFlowIdAtom, 'flow-1');
    store.set(activeOverlayAtom, 'flows');

    expect(store.set(exitTransientDestinationForNavigationAtom, SIDEBAR)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });
});

/**
 * Chat-focus writers outside the sidebar (task notifications, agent chat-moves) must land the user
 * on the chat they focused. The flow editor is the one destination that outranks them.
 */
describe('focusAgentChatAtom across the Flows sub-states', () => {
  it('leaves the Flows dashboard so the focused chat is visible', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');

    store.set(focusAgentChatAtom, 'chat-1');

    expect(store.get(activeOverlayAtom)).toBeNull();
    expect(store.get(selectedAgentChatIdAtom)).toBe('chat-1');
  });

  it('keeps the flow editor, which owns unsaved draft state', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, 'flow-1');

    store.set(focusAgentChatAtom, 'chat-1');

    expect(store.get(activeOverlayAtom)).toBe('flows');
    expect(store.get(selectedAgentChatIdAtom)).toBe('chat-1');
  });

  it.each(['workqueue', 'settings'] as const)('still exits the %s destination', (overlay) => {
    const store = createStore();
    store.set(activeOverlayAtom, overlay);

    store.set(focusAgentChatAtom, 'chat-1');

    expect(store.get(activeOverlayAtom)).toBeNull();
  });
});

/**
 * Settings stands in front of whatever it replaced, so the flow editor can be two levels down.
 * Authority over an external chat focus belongs to that origin, not to the Settings frame.
 */
describe('focusAgentChatAtom when Settings stands in for Flows', () => {
  const settingsOver = (flowId: string | null) => {
    const store = createStore();
    store.set(flowsSelectedFlowIdAtom, flowId);
    store.set(activeOverlayAtom, 'flows');
    store.set(agentsSettingsDialogOpenAtom, true);
    return store;
  };

  it('never discards a flow editor sitting behind Settings', () => {
    const store = settingsOver('flow-1');

    store.set(focusAgentChatAtom, 'chat-1');

    expect(store.get(activeOverlayAtom)).toBe('settings');
    expect(store.get(selectedAgentChatIdAtom)).toBe('chat-1');
    // The return target must survive too, or closing Settings would strand the editor.
    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('yields when only the dashboard is behind Settings', () => {
    const store = settingsOver(null);

    store.set(focusAgentChatAtom, 'chat-1');

    expect(store.get(activeOverlayAtom)).toBeNull();
    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });
});
