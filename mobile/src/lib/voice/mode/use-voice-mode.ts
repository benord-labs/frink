import { useIsFocused } from '@react-navigation/native';
import { requireOptionalNativeModule } from 'expo';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { useOutbox } from '../../chat/use-outbox';
import { useConnection } from '../../connection';
import { VOICE_MODE_MODULES, voiceAvailable } from '../available';
import { nativeRecognizer } from '../recognizer';
import { answerRequest, openDecision, sameRequestId, type Answer } from './answer';
import { switchAwake, type KeepAwake } from './keep-awake';
import { follow, type Following } from './reply';
import { VoiceSession } from './session';
import { nativeSpeaker } from './speaker';
import { PAUSED } from './turn';

/** False on web and on builds without speech output or keep-awake, which then offer no voice mode. */
export const voiceModeSupported = voiceAvailable(
  VOICE_MODE_MODULES,
  Platform.OS,
  requireOptionalNativeModule,
);

const AWAKE_TAG = 'voice-mode';

/** The keep-awake package. Loaded only once voice mode is known to be available. */
function loadKeepAwake(): KeepAwake {
  // SAFETY: a plain require keeps the package out of the app's start-up; its types are the package's own.
  return require('expo-keep-awake') as typeof import('expo-keep-awake');
}

const tapped = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

/**
 * Hands-free talk with one conversation. It runs only while its screen is in front and the app is
 * open, and everything it started (microphone, speech, keep-awake) stops when it ends.
 */
export function useVoiceMode({
  chatId,
  subChatId,
  data,
  refresh,
}: {
  chatId: string;
  subChatId: string;
  data: MobileChatDetail | undefined;
  refresh: () => void;
}) {
  const { connection, request } = useConnection();
  const focused = useIsFocused();
  const outbox = useOutbox({ chatId, subChatId, data, refresh });
  const [state, setState] = useState(PAUSED);
  const session = useRef<VoiceSession | null>(null);
  const reader = useRef<Following | null>(null);
  const latest = useRef(data);
  latest.current = data;
  // The newest outbox and request, for answers given long after the session started.
  const send = useRef(outbox.post);
  send.current = outbox.post;
  const ask = useRef(request);
  ask.current = request;
  const answerIds = useRef(new Map<string, string>());
  const deviceId = connection?.deviceId;

  async function answer(given: Answer) {
    const requestId = sameRequestId(
      answerIds.current,
      `${given.kind}:${given.id}`,
      Crypto.randomUUID,
    );
    const body = latest.current && answerRequest(given, latest.current, requestId);
    if (!body) return false;
    try {
      await ask.current(body);
      refresh();
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (!voiceModeSupported || !focused) return;
    const current = new VoiceSession({
      recognizer: nativeRecognizer,
      speaker: nativeSpeaker,
      send: (text) => {
        tapped();
        return send.current(Crypto.randomUUID(), text);
      },
      answer,
      onChange: setState,
    });
    session.current = current;
    if (latest.current) current.decision(openDecision(latest.current));
    void current.resume();
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'background') current.pause();
    });
    return () => {
      app.remove();
      current.close();
      session.current = null;
      setState(PAUSED);
    };
    // A new chat, conversation or computer is a new session.
  }, [focused, chatId, subChatId, deviceId]);

  const awake = !state.paused;
  useEffect(() => {
    if (!voiceModeSupported || !awake) return;
    switchAwake(true, AWAKE_TAG, loadKeepAwake);
    return () => switchAwake(false, AWAKE_TAG, loadKeepAwake);
  }, [awake]);

  // Each snapshot of the chat: new reply sentences are spoken, then any open decision is asked.
  useEffect(() => {
    const next = data && follow(reader.current, { deviceId, chatId, subChatId }, data);
    if (!next) return;
    reader.current = next.following;
    session.current?.snapshot(next.lines, openDecision(data));
  }, [data]);

  return {
    state,
    pending: outbox.pending,
    tap: () => {
      tapped();
      session.current?.tap();
    },
  };
}
