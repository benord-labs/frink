import { useEffect, useRef, useState } from 'react';
import type { PluginDefinition } from '../../../shared/integrations/plugins';
import { usePluginChatTools } from '../../hooks/usePluginChatTools';
import { hasChatMcp, isChatOnlyPlugin, userTokenAuth } from './plugin-view-model';

/** One live chat-status poll per plugin page, plus the one Connect the page's header and its locked prompts share. */
export function usePluginChatGrant(
  definition: PluginDefinition | undefined,
  onConnect: (pluginId: string) => void,
) {
  const chatCapable = definition !== undefined && hasChatMcp(definition);
  const chat = usePluginChatTools(chatCapable ? definition.id : '', { live: chatCapable });
  const [tokenOpen, setTokenOpen] = useState(false);
  const tokenAuth = definition ? userTokenAuth(definition) : undefined;
  const chatOnly = definition !== undefined && isChatOnlyPlugin(definition);
  // Two clicks in the same tick (header Connect + a locked prompt) must start one consent: the ref
  // closes the window before React publishes `isEnabling`, and reopens once the mutation settles.
  const started = useRef(false);
  useEffect(() => {
    if (!chat.isEnabling) started.current = false;
  }, [chat.isEnabling]);
  /** In-app legs first (a pasted token), then the browser: the connect chain for a provider plugin, the vendor consent for a chat-only one. */
  const run = () => {
    if (!definition || chat.isEnabling) return;
    if (tokenAuth && chat.state !== 'connected') {
      setTokenOpen(true);
      return;
    }
    if (!chatOnly) {
      onConnect(definition.id);
      return;
    }
    // A pinned package has no runtime server until its first install stages the payload.
    if ((chat.state !== 'awaiting' && chat.state !== 'none') || started.current) return;
    started.current = true;
    chat.enable();
  };
  return {
    chat,
    chatOnly,
    connect: run,
    granted: chatOnly && chat.state === 'connected',
    tokenAuth,
    tokenOpen,
    setTokenOpen,
    run,
    /** The token landed: a provider plugin goes straight on to its account leg; a chat-only plugin is done. */
    onTokenSaved: definition && !chatOnly ? () => onConnect(definition.id) : undefined,
  };
}
