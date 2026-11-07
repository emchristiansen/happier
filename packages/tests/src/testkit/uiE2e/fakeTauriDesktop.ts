import type { Page } from '@playwright/test';

const MAIN_WINDOW_LABEL = 'main';
const DESKTOP_WINDOW_STATE_EVENT = 'desktopWindow://state';
const WINDOW_MOVED_EVENT = 'tauri://move';
const WINDOW_RESIZED_EVENT = 'tauri://resize';

export type FakeTauriDesktopPlatform = 'macos' | 'windows' | 'linux';
export type FakeTauriDesktopStrategy = 'none' | 'native-macos-traffic-lights' | 'custom-controls';

export type FakeTauriDesktopUpdateState = Readonly<{ installed?: boolean; version: string; currentVersion?: string }>;

/**
 * How `desktop_download_update` behaves: `succeed` resolves at once, `fail` rejects, `hold` emits one
 * progress event (`holdPercent`, default 42) and waits for `releaseFakeTauriDesktopDownload`.
 */
export type FakeTauriDesktopUpdateDownload = 'succeed' | 'fail' | 'hold';

export type FakeTauriDesktopControlsState = Readonly<{
  closeCount: number;
  dragCount: number;
  minimizeCount: number;
  toggleMaximizeCount: number;
}>;

export type FakeTauriDesktopInvokeLogEntry = Readonly<{ args: Record<string, unknown> | null; command: string }>;

export type FakeTauriDesktopState = Readonly<{
  autostartEnabled: boolean;
  controls: FakeTauriDesktopControlsState;
  currentWindowLabel: string;
  invokeLog: readonly FakeTauriDesktopInvokeLogEntry[];
  isMaximized: boolean;
  platform: FakeTauriDesktopPlatform;
  strategy: FakeTauriDesktopStrategy;
  trayState: Record<string, unknown> | null;
  updateAvailable: FakeTauriDesktopUpdateState | null;
  updateDownload: FakeTauriDesktopUpdateDownload;
  holdPercent: number;
}>;

export type FakeTauriDesktopCommandResult = Readonly<{
  result: unknown;
  state: FakeTauriDesktopState;
}>;

type MutableFakeTauriDesktopWindow = Window & {
  __HAPPIER_FAKE_TAURI_DESKTOP__?: FakeTauriDesktopState;
  __HAPPIER_FAKE_TAURI_EVENT_LISTENERS__?: Record<string, number[]>;
  /** Delivers a Tauri event to the page's listeners, as the Rust side's `app.emit` does. */
  __HAPPIER_FAKE_TAURI_EMIT__?: (event: string, payload: unknown) => void;
  /** Settles a held `desktop_download_update` (`true` → downloaded, `false` → the download fails). */
  __HAPPIER_FAKE_TAURI_RELEASE_DOWNLOAD__?: (ok: boolean) => void;
  __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, id: number) => void };
  __TAURI_INTERNALS__?: {
    callbacks?: Map<number, (data: unknown) => unknown>;
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    metadata?: {
      currentWindow: { label: string };
      currentWebview: { label: string; windowLabel: string };
    };
    runCallback?: (id: number, data: unknown) => void;
    transformCallback?: (callback: ((data: unknown) => unknown) | undefined, once?: boolean) => number;
    unregisterCallback?: (id: number) => void;
  };
};

function resolveDefaultStrategy(platform: FakeTauriDesktopPlatform): FakeTauriDesktopStrategy {
  return platform === 'macos' ? 'native-macos-traffic-lights' : 'custom-controls';
}

function resolveChromeStrategy(
  state: Pick<FakeTauriDesktopState, 'currentWindowLabel' | 'platform' | 'strategy'>,
): FakeTauriDesktopStrategy {
  if (state.currentWindowLabel !== MAIN_WINDOW_LABEL) return 'none';
  return state.strategy === 'none' ? resolveDefaultStrategy(state.platform) : state.strategy;
}

function createNextStateBase(
  state: FakeTauriDesktopState,
  command: string,
  args?: Record<string, unknown>,
): FakeTauriDesktopState {
  return {
    ...state,
    controls: { ...state.controls },
    invokeLog: [...state.invokeLog, { args: args ?? null, command }],
  };
}

function applyWindowCommand(
  state: FakeTauriDesktopState,
  command: string,
): FakeTauriDesktopCommandResult {
  if (command === 'desktop_minimize_window') {
    return {
      result: true,
      state: {
        ...state,
        controls: { ...state.controls, minimizeCount: state.controls.minimizeCount + 1 },
      },
    };
  }

  if (command === 'desktop_toggle_window_maximize') {
    const isMaximized = !state.isMaximized;
    return {
      result: true,
      state: {
        ...state,
        controls: {
          ...state.controls,
          toggleMaximizeCount: state.controls.toggleMaximizeCount + 1,
        },
        isMaximized,
      },
    };
  }

  if (command === 'desktop_close_window') {
    return {
      result: true,
      state: {
        ...state,
        controls: { ...state.controls, closeCount: state.controls.closeCount + 1 },
      },
    };
  }

  if (command === 'desktop_start_window_dragging') {
    return {
      result: true,
      state: {
        ...state,
        controls: { ...state.controls, dragCount: state.controls.dragCount + 1 },
      },
    };
  }

  if (command === 'desktop_get_window_state') {
    return { result: { isMaximized: state.isMaximized }, state };
  }

  return { result: null, state };
}

export function createFakeTauriDesktopState(
  overrides: Partial<FakeTauriDesktopState> = {},
): FakeTauriDesktopState {
  const platform = overrides.platform ?? 'macos';
  return {
    autostartEnabled: overrides.autostartEnabled ?? false,
    controls: {
      closeCount: 0,
      dragCount: 0,
      minimizeCount: 0,
      toggleMaximizeCount: 0,
      ...(overrides.controls ?? {}),
    },
    currentWindowLabel: overrides.currentWindowLabel ?? MAIN_WINDOW_LABEL,
    invokeLog: overrides.invokeLog ?? [],
    isMaximized: overrides.isMaximized ?? false,
    platform,
    strategy: overrides.strategy ?? resolveDefaultStrategy(platform),
    trayState: overrides.trayState ?? null,
    updateAvailable: overrides.updateAvailable ?? null,
    updateDownload: overrides.updateDownload ?? 'succeed',
    holdPercent: overrides.holdPercent ?? 42,
  };
}

export async function applyFakeTauriDesktopCommand(
  state: FakeTauriDesktopState,
  command: string,
  args?: Record<string, unknown>,
): Promise<FakeTauriDesktopCommandResult> {
  const nextStateBase = createNextStateBase(state, command, args);

  switch (command) {
    case 'plugin:event|listen':
    case 'plugin:event|unlisten':
    case 'plugin:event|emit':
    case 'plugin:event|emit_to':
    case 'desktop_show_main_window':
      return { result: null, state: nextStateBase };
    case 'desktop_get_window_chrome_policy':
      return {
        result: { strategy: resolveChromeStrategy(nextStateBase) },
        state: nextStateBase,
      };
    case 'desktop_fetch_update':
      return { result: nextStateBase.updateAvailable, state: nextStateBase };
    case 'desktop_download_update':
      if (nextStateBase.updateDownload === 'fail') throw new Error('error sending request for url');
      return { result: nextStateBase.updateAvailable != null, state: nextStateBase };
    case 'desktop_install_update': {
      const updateAvailable = nextStateBase.updateAvailable
        ? { ...nextStateBase.updateAvailable, installed: true }
        : null;
      return {
        result: updateAvailable != null,
        state: { ...nextStateBase, updateAvailable },
      };
    }
    case 'desktop_set_tray_state':
      return { result: null, state: { ...nextStateBase, trayState: args ?? null } };
    case 'desktop_get_autostart_enabled':
      return { result: nextStateBase.autostartEnabled, state: nextStateBase };
    case 'desktop_set_autostart_enabled': {
      const autostartEnabled = args?.enabled === true;
      return {
        result: autostartEnabled,
        state: { ...nextStateBase, autostartEnabled },
      };
    }
    case 'desktop_minimize_window':
    case 'desktop_toggle_window_maximize':
    case 'desktop_close_window':
    case 'desktop_start_window_dragging':
    case 'desktop_get_window_state':
      return applyWindowCommand(nextStateBase, command);
    default:
      return { result: null, state: nextStateBase };
  }
}

export async function installFakeTauriDesktopBridge(
  page: Page,
  options: Readonly<{ state?: Partial<FakeTauriDesktopState> }> = {},
): Promise<void> {
  const initialState = createFakeTauriDesktopState(options.state);
  const installBridge = (serializedState: FakeTauriDesktopState) => {
    const mainWindowLabel = 'main';
    const desktopWindowStateEvent = 'desktopWindow://state';
    const windowMovedEvent = 'tauri://move';
    const windowResizedEvent = 'tauri://resize';
    const win = window as MutableFakeTauriDesktopWindow;
    const systemTaskHostBinding = '__HAPPIER_FAKE_TAURI_SYSTEM_TASK_HOST__';
    const systemTaskCommands = [
      'start_system_task',
      'get_system_task_snapshot',
      'cancel_system_task',
      'respond_system_task_prompt',
    ];
    const callbacks = new Map<number, (data: unknown) => unknown>();
    const listenersByEvent: Record<string, number[]> = Object.create(null);
    let nextCallbackId = 1;

    const resolveDefaultStrategy = (platform: FakeTauriDesktopPlatform): FakeTauriDesktopStrategy =>
      platform === 'macos' ? 'native-macos-traffic-lights' : 'custom-controls';
    const resolveChromeStrategy = (
      state: Pick<FakeTauriDesktopState, 'currentWindowLabel' | 'platform' | 'strategy'>,
    ): FakeTauriDesktopStrategy => {
      if (state.currentWindowLabel !== mainWindowLabel) return 'none';
      return state.strategy === 'none' ? resolveDefaultStrategy(state.platform) : state.strategy;
    };
    const emitEvent = (event: string, payload: unknown) => {
      for (const callbackId of listenersByEvent[event] ?? []) {
        callbacks.get(callbackId)?.({ event, id: callbackId, payload });
      }
    };
    const unregisterListener = (event: string, id: number) => {
      listenersByEvent[event] = (listenersByEvent[event] ?? []).filter((value) => value !== id);
      callbacks.delete(id);
    };
    const transformCallback = (callback: ((data: unknown) => unknown) | undefined, once = false): number => {
      const callbackId = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(callbackId, (data) => {
        if (once) callbacks.delete(callbackId);
        return callback?.(data);
      });
      return callbackId;
    };
    const apply = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      // System-task commands go to the Node-side host when a spec attached one
      // (`desktopSystemTaskHost.ts`), the way the Rust bridge relays them to the bundled hsetup.
      const systemTaskHost = (win as unknown as Record<string, unknown>)[systemTaskHostBinding];
      if (systemTaskCommands.includes(command) && typeof systemTaskHost === 'function') {
        return await (systemTaskHost as (command: string, args: Record<string, unknown> | null) => Promise<unknown>)(
          command,
          args ?? null,
        );
      }
      const current = win.__HAPPIER_FAKE_TAURI_DESKTOP__ ?? serializedState;
      const base = {
        ...current,
        controls: { ...current.controls },
        invokeLog: [...current.invokeLog, { args: args ?? null, command }],
      };
      let nextState: FakeTauriDesktopState = base;
      let result: unknown = null;

      if (command === 'desktop_get_window_chrome_policy') {
        result = { strategy: resolveChromeStrategy(base) };
      } else if (command === 'desktop_get_window_state') {
        result = { isMaximized: base.isMaximized };
      } else if (command === 'desktop_fetch_update') {
        result = base.updateAvailable;
      } else if (command === 'desktop_download_update') {
        win.__HAPPIER_FAKE_TAURI_DESKTOP__ = base;
        const offered = base.updateAvailable;
        if (!offered) return false;
        if (base.updateDownload === 'fail') throw new Error('error sending request for url');
        if (base.updateDownload === 'hold') {
          emitEvent('desktop_update_download_progress', {
            version: offered.version,
            downloadedBytes: base.holdPercent,
            totalBytes: 100,
          });
          return await new Promise<boolean>((resolve, reject) => {
            win.__HAPPIER_FAKE_TAURI_RELEASE_DOWNLOAD__ = (ok) => {
              win.__HAPPIER_FAKE_TAURI_RELEASE_DOWNLOAD__ = undefined;
              if (ok) resolve(true);
              else reject(new Error('error sending request for url'));
            };
          });
        }
        return true;
      } else if (command === 'desktop_install_update') {
        const updateAvailable = base.updateAvailable ? { ...base.updateAvailable, installed: true } : null;
        nextState = { ...base, updateAvailable };
        result = updateAvailable != null;
      } else if (command === 'desktop_set_tray_state') {
        nextState = { ...base, trayState: args ?? null };
      } else if (command === 'desktop_get_autostart_enabled') {
        result = base.autostartEnabled;
      } else if (command === 'desktop_set_autostart_enabled') {
        const autostartEnabled = args?.enabled === true;
        nextState = { ...base, autostartEnabled };
        result = autostartEnabled;
      } else if (command === 'desktop_minimize_window') {
        nextState = {
          ...base,
          controls: { ...base.controls, minimizeCount: base.controls.minimizeCount + 1 },
        };
        result = true;
      } else if (command === 'desktop_toggle_window_maximize') {
        const isMaximized = !base.isMaximized;
        nextState = {
          ...base,
          controls: {
            ...base.controls,
            toggleMaximizeCount: base.controls.toggleMaximizeCount + 1,
          },
          isMaximized,
        };
        result = true;
      } else if (command === 'desktop_close_window') {
        nextState = {
          ...base,
          controls: { ...base.controls, closeCount: base.controls.closeCount + 1 },
        };
        result = true;
      } else if (command === 'desktop_start_window_dragging') {
        nextState = {
          ...base,
          controls: { ...base.controls, dragCount: base.controls.dragCount + 1 },
        };
        result = true;
      }

      win.__HAPPIER_FAKE_TAURI_DESKTOP__ = nextState;

      if (command === 'plugin:event|listen') {
        const event = String(args?.event ?? '').trim();
        const handler = Number(args?.handler);
        if (event && Number.isFinite(handler)) {
          listenersByEvent[event] = [...(listenersByEvent[event] ?? []), handler];
          return handler;
        }
      } else if (command === 'plugin:event|unlisten') {
        const event = String(args?.event ?? '').trim();
        const eventId = Number(args?.eventId);
        if (event && Number.isFinite(eventId)) unregisterListener(event, eventId);
      } else if (command === 'plugin:event|emit' || command === 'plugin:event|emit_to') {
        const event = String(args?.event ?? '').trim();
        if (event) emitEvent(event, args?.payload ?? null);
      }

      if (command === 'desktop_toggle_window_maximize') {
        emitEvent(desktopWindowStateEvent, { isMaximized: nextState.isMaximized });
        emitEvent(windowResizedEvent, {
          width: nextState.isMaximized ? 1440 : 1280,
          height: nextState.isMaximized ? 900 : 820,
        });
      } else if (command === 'desktop_start_window_dragging') {
        emitEvent(windowMovedEvent, { x: 32, y: 24 });
      }

      return result;
    };

    win.__HAPPIER_FAKE_TAURI_DESKTOP__ = serializedState;
    win.__HAPPIER_FAKE_TAURI_EVENT_LISTENERS__ = listenersByEvent;
    win.__TAURI_INTERNALS__ = {
      callbacks,
      invoke: apply,
      metadata: {
        currentWindow: { label: serializedState.currentWindowLabel },
        currentWebview: {
          label: serializedState.currentWindowLabel,
          windowLabel: serializedState.currentWindowLabel,
        },
      },
      runCallback: (id, data) => callbacks.get(id)?.(data),
      transformCallback,
      unregisterCallback: (id) => callbacks.delete(id),
    };
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener };
    win.__HAPPIER_FAKE_TAURI_EMIT__ = emitEvent;
    win.__TAURI__ = { core: { invoke: apply } };
  };

  await page.addInitScript(installBridge, initialState);
  if (page.url() !== 'about:blank') {
    await page.evaluate(installBridge, initialState);
  }
}

export async function readFakeTauriDesktopState(page: Page): Promise<FakeTauriDesktopState> {
  return page.evaluate(() => {
    const win = window as MutableFakeTauriDesktopWindow;
    if (!win.__HAPPIER_FAKE_TAURI_DESKTOP__) {
      throw new Error('Fake Tauri desktop bridge is not installed.');
    }
    return win.__HAPPIER_FAKE_TAURI_DESKTOP__;
  });
}

export async function invokeFakeTauriDesktopCommand(
  page: Page,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(
    async ({ resolvedArgs, resolvedCommand }) => {
      const win = window as MutableFakeTauriDesktopWindow;
      if (!win.__TAURI_INTERNALS__?.invoke) {
        throw new Error('Fake Tauri desktop bridge is not installed.');
      }
      return win.__TAURI_INTERNALS__.invoke(resolvedCommand, resolvedArgs ?? undefined);
    },
    { resolvedArgs: args ?? null, resolvedCommand: command },
  );
}

export async function navigateSpa(page: Page, path: string): Promise<void> {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Settles a download the fake bridge is holding (`updateDownload: 'hold'`). */
export async function releaseFakeTauriDesktopDownload(page: Page, ok: boolean): Promise<void> {
  await page.evaluate((resolvedOk) => {
    const win = window as MutableFakeTauriDesktopWindow;
    win.__HAPPIER_FAKE_TAURI_RELEASE_DOWNLOAD__?.(resolvedOk);
  }, ok);
}
