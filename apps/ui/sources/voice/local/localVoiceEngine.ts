import { AudioModule, RecordingPresets } from 'expo-audio';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import { MissingGeminiApiKeyError, MissingSttBaseUrlError, transcribeRecordedAudioWithProvider } from '@/voice/input/transcribeRecordedAudioWithProvider';
import { resolveSttFailureCode } from '@/voice/input/sttRequestError';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { findVoiceConversationSessionId } from '@/voice/sessionBinding/voiceConversationSession';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController, scopePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import { appendVoiceConversationAssistantText } from '@/voice/sessionBinding/voiceConversationTranscript';
import {
  resolveVoiceSessionBindingByControlSessionId,
  resolveVoiceSessionBindingByConversationSessionId,
} from '@/voice/sessionBinding/resolveVoiceSessionBinding';

import type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
import {
  claimLocalVoiceTurnPublication,
  createLocalVoiceTurnStateWriter,
  getLocalVoiceState,
  patchLocalVoiceState,
  resolveLocalVoiceError,
  type LocalVoiceTurnStateWriter,
} from './localVoiceState';
import {
  isHandsFreeSttEnabled,
  isVoiceBargeInEnabled,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from './localVoiceSettings';
import { sendVoiceTextTurn as sendVoiceTextTurnImpl } from './sendVoiceTextTurn';

export type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
export { getLocalVoiceState, useLocalVoiceStatus, subscribeLocalVoiceState } from './localVoiceState';

let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
let inFlight: Promise<void> | null = null;
let activeTurnAbortController: AbortController | null = null;
let activeTurnAbortSessionId: string | null = null;
/**
 * The connect-time welcome is not a voice turn, but it speaks and reports failures on the call
 * surface. Its authority ends when the interaction it was started for does: hang-up, a newer
 * connect, or a voice turn that takes over the call. Revoking aborts this controller; the welcome
 * then neither starts speech nor publishes state, and speech it already started is stopped.
 */
let activeWelcomeController: AbortController | null = null;

function beginWelcome(): AbortSignal {
  revokeWelcome();
  const controller = new AbortController();
  activeWelcomeController = controller;
  return controller.signal;
}

function revokeWelcome(): void {
  const controller = activeWelcomeController;
  activeWelcomeController = null;
  controller?.abort();
}

const playbackController = createVoicePlaybackController();
const deviceSttController = createDeviceSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
  canAutoStopTurn: () => !inFlight,
  onAutoStopTurn: (sessionId: string) => {
    if (inFlight) return;
    inFlight = stopDeviceSpeechRecognitionAndSend(sessionId)
      .catch((error) => {
        // Hands-free auto-stop has no awaiting caller; surface the failure on the voice surface.
        patchLocalVoiceState({ status: 'idle', ...resolveLocalVoiceError(error, 'stt_failed') });
      })
      .finally(() => {
        inFlight = null;
      });
  },
});
const sherpaSttController = createSherpaStreamingSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
  canAutoStopTurn: () => !inFlight,
  onAutoStopTurn: (sessionId: string) => {
    if (inFlight) return;
    inFlight = stopSherpaSpeechRecognitionAndSend(sessionId).finally(() => {
      inFlight = null;
    });
  },
});

function isUnsupportedVoiceAgentPrewarmError(error: unknown): boolean {
  const carrier: RpcErrorCarrier =
    error && typeof error === 'object'
      ? (error as RpcErrorCarrier)
      : { message: typeof error === 'string' ? error : undefined };
  return isRpcMethodNotAvailableError(carrier) || isRpcMethodNotFoundError(carrier);
}

function isAbortedVoiceTurnError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof Error && error.message === 'turn_aborted';
}

/**
 * Runs one voice turn. Failures never reject: they are surfaced through the local voice error state
 * (rendered by the voice surface) so hands-free loops keep running and fire-and-forget callers do
 * not produce unhandled rejections. A more specific error already recorded by the turn is kept.
 */
async function runVoiceTurnWithSendFailureHandling(
  sessionId: string,
  runner: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  await runAbortableVoiceTurn(sessionId, (signal) => handleVoiceTurnSendFailure(sessionId, signal, runner));
}

async function handleVoiceTurnSendFailure(
  sessionId: string,
  signal: AbortSignal,
  runner: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  const turnState = createLocalVoiceTurnStateWriter(signal);
  turnState.patch({ error: null });
  try {
    await runner(signal);
  } catch (error) {
    if (isAbortedVoiceTurnError(error) || signal.aborted) {
      return;
    }
    if (getLocalVoiceState().error) {
      return;
    }
    turnState.patch({ status: 'idle', sessionId, ...resolveLocalVoiceError(error, 'send_failed') });
  }
}

async function startRecording(sessionId: string): Promise<void> {
  const permission = await requestMicrophonePermission();
  if (!permission.granted) {
    showMicrophonePermissionDeniedAlert(permission.canAskAgain);
    return;
  }

  // Expo's types describe the native module; its web namespace exposes AudioRecorderWeb.
  const audioModule = AudioModule as typeof AudioModule & {
    AudioRecorderWeb?: typeof AudioModule.AudioRecorder;
  };
  const Recorder = audioModule.AudioRecorderWeb ?? audioModule.AudioRecorder;
  const nextRecorder = new Recorder(RecordingPresets.HIGH_QUALITY);
  try {
    await nextRecorder.prepareToRecordAsync();
    nextRecorder.record();
    recorder = nextRecorder;
    patchLocalVoiceState({ status: 'recording', sessionId, error: null });
  } catch (error) {
    try {
      await nextRecorder.stop?.();
    } catch {
      // best-effort
    }
    recorder = null;
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: 'recording_start_failed' });
    throw error;
  }
}

async function stopAndSendRecordedTurn(sessionId: string): Promise<void> {
  await runAbortableVoiceTurn(sessionId, async (signal, turnState) => {
    if (!recorder) {
      turnState.patch({ status: 'idle', sessionId, error: null });
      return;
    }

    const turnRecorder = recorder;
    recorder = null;
    turnState.patch({ status: 'transcribing', error: null });
    let uri: string | null = null;
    try {
      await turnRecorder.stop();
      if (signal.aborted) return;
      uri = turnRecorder.uri;
    } catch {
      if (signal.aborted) return;
      turnState.patch({ status: 'idle', sessionId, error: 'recording_stop_failed' });
      return;
    }
    if (!uri) {
      turnState.patch({ status: 'idle', sessionId, error: null });
      return;
    }

    const settings = storage.getState().settings as any;
    let text: string | null = null;
    try {
      text = await transcribeRecordedAudioWithProvider({ uri, settings });
      if (signal.aborted) return;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof MissingSttBaseUrlError) {
        turnState.patch({ status: 'idle', sessionId, error: 'missing_stt_base_url' });
        throw error;
      }
      if (error instanceof MissingGeminiApiKeyError) {
        turnState.patch({ status: 'idle', sessionId, error: 'missing_stt_api_key' });
        throw error;
      }
      turnState.patch({ status: 'idle', sessionId, error: resolveSttFailureCode(error) });
      return;
    }

    if (!text) {
      turnState.patch({ status: 'idle', sessionId, error: null });
      return;
    }

    await handleVoiceTurnSendFailure(sessionId, signal, (signal) =>
      sendVoiceTextTurnImpl({
        sessionId,
        settings,
        userText: text,
        playbackController,
        voiceAgentSessions,
        signal,
      }),
    );
  });
}

async function stopDeviceSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  await runAbortableVoiceTurn(sessionId, async (signal, turnState) => {
    turnState.patch({ status: 'transcribing', error: null });

    const text = await deviceSttController.stop(sessionId);
    if (signal.aborted) return;
    if (!text) {
      if (!signal.aborted && deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeSttEnabled(storage.getState().settings)) {
        await deviceSttController.start(sessionId);
        return;
      }
      turnState.patch({ status: 'idle', sessionId, error: null });
      return;
    }

    const settings = storage.getState().settings as any;
    await handleVoiceTurnSendFailure(sessionId, signal, (signal) =>
      sendVoiceTextTurnImpl({
        sessionId,
        settings,
        userText: text,
        playbackController,
        voiceAgentSessions,
        signal,
      }),
    );

    if (!signal.aborted && deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeSttEnabled(storage.getState().settings)) {
      await deviceSttController.start(sessionId);
    }
  });
}

async function stopSherpaSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  await runAbortableVoiceTurn(sessionId, async (signal, turnState) => {
    turnState.patch({ status: 'transcribing', error: null });

    const text = await sherpaSttController.stop(sessionId);
    if (signal.aborted) return;
    if (!text) {
      if (!signal.aborted && sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeSttEnabled(storage.getState().settings)) {
        await sherpaSttController.start(sessionId);
        return;
      }
      turnState.patch({ status: 'idle', sessionId, error: null });
      return;
    }

    const settings = storage.getState().settings as any;
    await handleVoiceTurnSendFailure(sessionId, signal, (signal) =>
      sendVoiceTextTurnImpl({
        sessionId,
        settings,
        userText: text,
        playbackController,
        voiceAgentSessions,
        signal,
      }),
    );

    if (!signal.aborted && sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeSttEnabled(storage.getState().settings)) {
      await sherpaSttController.start(sessionId);
    }
  });
}

export async function stopLocalVoiceAgent(sessionId: string): Promise<void> {
  deviceSttController.clearHandsFreeSession(sessionId);
  sherpaSttController.clearHandsFreeSession(sessionId);
  await voiceAgentSessions.stop(sessionId);
}

export async function resetLocalVoiceAgentPersistence(): Promise<void> {
  await resetVoiceAgentPersistenceState({
    stop: async () => await stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID),
  });
}

export function isLocalVoiceAgentActive(sessionId: string): boolean {
  return voiceAgentSessions.isActive(sessionId);
}

export function appendLocalVoiceAgentContextUpdate(sessionId: string, update: string): void {
  voiceAgentSessions.appendContextUpdate(sessionId, update);
}

export function announceLocalVoiceAgentAssistantText(sessionId: string, text: string): void {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;

  voiceActivityController.appendAssistantText(sessionId, 'local_conversation', trimmed);

  const binding =
    resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId })
    ?? resolveVoiceSessionBindingByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const conversationSessionId = typeof binding?.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
  if (!conversationSessionId) return;

  appendVoiceConversationAssistantText({
    conversationSessionId,
    text: trimmed,
  });
}

export async function sendLocalVoiceAgentTextUpdate(sessionId: string, update: string): Promise<void> {
  const text = update.trim();
  if (!text) return;

  const settings = storage.getState().settings as any;
  await runVoiceTurnWithSendFailureHandling(sessionId, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions: {
        sendTurn: (nextSessionId, userText, opts) =>
          voiceAgentSessions.sendInterruptingTextUpdate(nextSessionId, userText, opts),
      },
      signal,
    }),
  );
}

/**
 * Runs one abortable voice turn. Starting it aborts the previous turn; cancel and hang-up abort it too.
 * The run holds the call-state publication right from its start until it completes; the runner
 * publishes local voice state only through `turnState`, which is silent once aborted or retired.
 */
async function runAbortableVoiceTurn(
  sessionId: string,
  runner: (signal: AbortSignal, turnState: LocalVoiceTurnStateWriter) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  // A voice turn takes the call over from a still-running connect-time welcome.
  revokeWelcome();
  if (activeTurnAbortController) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
  }
  activeTurnAbortController = controller;
  activeTurnAbortSessionId = sessionId;
  const retirePublication = claimLocalVoiceTurnPublication(controller.signal);
  try {
    await runner(controller.signal, createLocalVoiceTurnStateWriter(controller.signal));
  } finally {
    // A completed run is retired even though its signal stays live: continuations it left behind
    // (for example queued speech of a stream that failed after deltas) can no longer publish.
    retirePublication();
    if (activeTurnAbortController === controller) {
      activeTurnAbortController = null;
      activeTurnAbortSessionId = null;
    }
  }
}

export async function abortLocalVoiceTurn(sessionId: string): Promise<void> {
  const current = getLocalVoiceState();
  if (!current.sessionId) return;
  if (current.sessionId !== sessionId) return;

  playbackController.interrupt();
  if (activeTurnAbortController && activeTurnAbortSessionId === sessionId) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
  }

  patchLocalVoiceState({ status: 'idle', sessionId, error: null });
}

export async function toggleLocalVoiceTurn(sessionId: string): Promise<void> {
  const realtimeStatus = (storage.getState() as any)?.realtimeStatus;
  if (realtimeStatus === 'connected' || realtimeStatus === 'connecting') {
    // Avoid audio-session conflicts: local voice should not start while a realtime call is active.
    return;
  }

  const initialState = getLocalVoiceState();
  const canAttemptBargeIn =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && isVoiceBargeInEnabled(storage.getState().settings);
  const shouldNoopWhileSpeaking =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && !isVoiceBargeInEnabled(storage.getState().settings);

  if (shouldNoopWhileSpeaking) {
    return;
  }

  if (inFlight && !canAttemptBargeIn) {
    // A tap while a turn is starting, transcribing, or waiting for its reply is not a request to
    // record once that turn finishes; cancelling a pending reply is the surface's cancel control.
    return;
  }

  const current = getLocalVoiceState();
  const prewarmLocalVoiceAgentOnConnect = (params: Readonly<{ settings: any; config: any }>): void => {
    const { config } = params;
    if (config?.conversationMode !== 'agent' || config?.agent?.prewarmOnConnect !== true) return;

    fireAndForget(
      (async () => {
        const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
        const welcomeMode = config?.agent?.welcome?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
        const welcomeEnabled = config?.agent?.welcome?.enabled === true;
        const canSpeakWelcome = config?.tts?.autoSpeakReplies !== false;

        if (welcomeEnabled && welcomeMode === 'immediate' && canSpeakWelcome) {
          const welcomeSignal = beginWelcome();
          const assistantText = await voiceAgentSessions
            .ensureRunningAndMaybeWelcome(sessionId, { signal: welcomeSignal })
            .catch(() => null);
          const text = typeof assistantText === 'string' ? assistantText.trim() : '';
          // A welcome that arrives after hang-up, a newer connect or a voice turn has no call to speak to.
          if (text && !welcomeSignal.aborted) {
            voiceActivityController.appendAssistantText(sessionId, 'local_conversation', text);
            // The welcome plays while the mic is already being armed for the first turn. It only
            // owns the status when nothing else does, and hands it back when it finishes.
            let welcomeOwnsSpeakingStatus = false;
            await speakAssistantText({
              text,
              settings: params.settings,
              networkTimeoutMs,
              // Revoking the welcome also stops its own synthesis and playback, never a newer one's.
              registerPlaybackStopper: scopePlaybackStopperRegistrar(playbackController.registerStopper, welcomeSignal),
              onSpeaking: () => {
                if (welcomeSignal.aborted) return;
                const state = getLocalVoiceState();
                if (state.status !== 'idle' || state.sessionId !== sessionId) return;
                welcomeOwnsSpeakingStatus = true;
                patchLocalVoiceState({ status: 'speaking' });
              },
              // The welcome reports its own failure only while it still owns the interaction.
              onFailed: (failure) => {
                if (!welcomeSignal.aborted) patchLocalVoiceState(failure);
              },
            });
            const state = getLocalVoiceState();
            if (!welcomeSignal.aborted && welcomeOwnsSpeakingStatus && state.status === 'speaking' && state.sessionId === sessionId) {
              patchLocalVoiceState({ status: 'idle' });
            }
          }
          return;
        }

        await voiceAgentSessions.ensureRunning(sessionId);
      })().catch((error) => {
        if (isUnsupportedVoiceAgentPrewarmError(error)) return;
        throw error;
      }),
      { tag: 'localVoiceEngine.prewarmLocalVoiceAgentOnConnect' },
    );
  };

  if (current.status === 'speaking') {
    if (current.sessionId !== sessionId) {
      return;
    }

    if (!isVoiceBargeInEnabled(storage.getState().settings)) {
      return;
    }

    playbackController.interrupt();
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    deviceSttController.setHandsFreeSession(useDeviceStt && config?.handsFree?.enabled === true ? sessionId : null);
    sherpaSttController.setHandsFreeSession(useSherpaStt && config?.handsFree?.enabled === true ? sessionId : null);
    inFlight = (useDeviceStt ? deviceSttController.start(sessionId) : useSherpaStt ? sherpaSttController.start(sessionId) : startRecording(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'idle') {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    deviceSttController.setHandsFreeSession(useDeviceStt && config?.handsFree?.enabled === true ? sessionId : null);
    sherpaSttController.setHandsFreeSession(useSherpaStt && config?.handsFree?.enabled === true ? sessionId : null);
    inFlight = (useDeviceStt ? deviceSttController.start(sessionId) : useSherpaStt ? sherpaSttController.start(sessionId) : startRecording(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    if (current.sessionId !== sessionId) {
      return;
    }

    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    if (useDeviceStt) {
      deviceSttController.clearHandsFreeSession();
    }

    if (useSherpaStt) {
      sherpaSttController.clearHandsFreeSession();
    }

    inFlight = (useDeviceStt
      ? stopDeviceSpeechRecognitionAndSend(sessionId)
      : useSherpaStt
        ? stopSherpaSpeechRecognitionAndSend(sessionId)
        : stopAndSendRecordedTurn(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
}

export async function stopLocalVoiceSession(): Promise<void> {
  const current = getLocalVoiceState();
  if (!current.sessionId) return;

  playbackController.interrupt();
  revokeWelcome();

  const activeSessionId = current.sessionId;
  if (activeTurnAbortController && activeTurnAbortSessionId === activeSessionId) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
    activeTurnAbortController = null;
    activeTurnAbortSessionId = null;
  }

  // Best-effort stop any recording (we intentionally do not send).
  if (recorder) {
    try {
      await recorder.stop();
    } catch {
      // ignore
    }
    recorder = null;
  }

  if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
    // Hang-up ends hands-free first so no auto-stop or re-arm can run while recognizers stop.
    deviceSttController.clearHandsFreeSession(activeSessionId);
    sherpaSttController.clearHandsFreeSession(activeSessionId);

    try {
      await deviceSttController.stop(activeSessionId);
    } catch {
      // ignore
    }

    try {
      await sherpaSttController.stop(activeSessionId);
    } catch {
      // ignore
    }

    try {
      await voiceAgentSessions.stop(activeSessionId);
    } catch {
      // ignore
    }
  } else {
    deviceSttController.clearHandsFreeSession();
    sherpaSttController.clearHandsFreeSession();
  }

  patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
}
