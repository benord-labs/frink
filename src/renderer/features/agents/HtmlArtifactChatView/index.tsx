import type { ReactElement } from 'react';
import { HtmlArtifactPaneProvider } from '../HtmlArtifactPane';
import { ChatView } from '../main/active-chat';
import type { ChatViewProps } from '../main/active-chat/types';

type Props = ChatViewProps & { isPaneActive?: boolean };

export function HtmlArtifactChatView(props: Props): ReactElement {
  const paneKey = `${props.chatId}:${props.splitPaneIndex ?? 'single'}`;
  return (
    <HtmlArtifactPaneProvider paneKey={paneKey} isPaneActive={props.isPaneActive ?? true}>
      <ChatView {...props} />
    </HtmlArtifactPaneProvider>
  );
}
