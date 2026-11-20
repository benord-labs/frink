import { useRoute, type RouteProp } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { ArrowUp, Pause, Play, Square, type LucideIcon } from 'lucide-react-native';
import { voiceModeSupported, useVoiceMode } from '../../lib/voice/mode/use-voice-mode';
import { voiceControl, voiceStatus, type VoiceControl } from '../../lib/voice/mode/turn';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import type { RootRoutes } from '../../navigation/routes';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { useChatResource } from '../Chat';
import { PermissionForm, QuestionForm } from '../Chat/questions';

const SIZE = 96;
const CONTROLS: Record<VoiceControl, { label: string; icon: LucideIcon | null }> = {
  resume: { label: 'Carry on', icon: Play },
  interrupt: { label: 'Stop speaking', icon: Square },
  send: { label: 'Send now', icon: ArrowUp },
  wait: { label: 'Sending', icon: null },
  pause: { label: 'Pause', icon: Pause },
};

/** The one control: its job follows what voice mode is doing. */
function TalkButton({ control, onPress }: { control: VoiceControl; onPress: () => void }) {
  const t = useTheme();
  const { label, icon: Icon } = CONTROLS[control];
  const active = control !== 'resume';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !Icon }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? t.accent : t.fill,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {Icon ? (
        <Icon size={34} color={active ? t.onAccent : t.text} strokeWidth={2.2} />
      ) : (
        <ActivityIndicator color={t.onAccent} />
      )}
    </Pressable>
  );
}

/** The open request voice mode is asking about, so it can be answered here too. */
function OpenDecision({
  data,
  onAnswered,
}: {
  data: MobileChatDetail | undefined;
  onAnswered: () => void;
}) {
  const [permission] = data?.permissions ?? [];
  const [question] = data?.questions ?? [];
  if (!permission && !question) return null;
  return (
    <ScrollView style={{ flexGrow: 0, maxHeight: '45%', alignSelf: 'stretch' }}>
      {permission ? (
        <PermissionForm key={permission.requestId} prompt={permission} onAnswered={onAnswered} />
      ) : (
        <QuestionForm key={question.id} prompt={question} onAnswered={onAnswered} />
      )}
    </ScrollView>
  );
}

function VoiceView({ id, subChatId }: { id: string; subChatId: string }) {
  const resource = useChatResource(id, subChatId);
  const { data } = resource;
  const voice = useVoiceMode({ chatId: id, subChatId, data, refresh: resource.refresh });
  const { state } = voice;
  const control = voiceControl(state);
  const caption = state.saying?.line.text ?? state.heard.text;
  const sending = voice.pending.at(-1);
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.xl,
        paddingHorizontal: GUTTER,
      }}
    >
      <Text variant="label" color="muted" accessibilityLiveRegion="polite">
        {voiceStatus(state, data?.activity === 'running')}
      </Text>
      <Text variant="secondary" style={{ textAlign: 'center', minHeight: 60 }} numberOfLines={6}>
        {caption || (state.paused ? '' : 'Say what you need. A short pause sends it.')}
      </Text>
      <OpenDecision data={data} onAnswered={resource.refresh} />
      <TalkButton control={control} onPress={voice.tap} />
      <Text variant="label" color="muted" style={{ textAlign: 'center' }}>
        {CONTROLS[control].label}
      </Text>
      {sending && (
        <Text variant="secondary" color="muted" style={{ textAlign: 'center' }} numberOfLines={2}>
          {`${sending.state === 'failed' ? 'Not sent' : 'Sending'}: ${sending.text}`}
        </Text>
      )}
      {!!state.notice && (
        <Text variant="secondary" color="secondary" style={{ textAlign: 'center' }}>
          {state.notice}
        </Text>
      )}
    </View>
  );
}

/** Hands-free talk with one conversation: speak, hear the reply, answer requests by voice. */
export function VoiceModeScreen() {
  const { params } = useRoute<RouteProp<RootRoutes, 'Voice'>>();
  return (
    <Screen atmosphere>
      {voiceModeSupported ? (
        <VoiceView
          key={`${params.id}:${params.subChatId}`}
          id={params.id}
          subChatId={params.subChatId}
        />
      ) : (
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: GUTTER }}>
          <Text variant="secondary" color="secondary" style={{ textAlign: 'center' }}>
            Voice mode needs the newest version of the Frink app.
          </Text>
        </View>
      )}
    </Screen>
  );
}
