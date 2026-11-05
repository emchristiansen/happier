import { describe, expect, it, vi } from 'vitest';

import { createVoicePlaybackController, scopePlaybackStopperRegistrar } from './VoicePlaybackController';

describe('createVoicePlaybackController', () => {
  it('invalidates the captured epoch on interrupt even when nothing is playing yet', () => {
    const controller = createVoicePlaybackController();
    const epoch = controller.captureEpoch();

    controller.interrupt();

    expect(controller.isEpochCurrent(epoch)).toBe(false);
  });

  it('stops every active playback on interrupt, not only the most recently registered one', () => {
    const controller = createVoicePlaybackController();
    const stopWelcome = vi.fn();
    const stopTurn = vi.fn();
    controller.registerStopper(stopWelcome);
    controller.registerStopper(stopTurn);

    controller.interrupt();

    expect(stopWelcome).toHaveBeenCalledTimes(1);
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it('does not call a stopper after its playback cleared it', () => {
    const controller = createVoicePlaybackController();
    const stopper = vi.fn();
    const clear = controller.registerStopper(stopper);
    clear();

    controller.interrupt();

    expect(stopper).not.toHaveBeenCalled();
  });
});

describe('scopePlaybackStopperRegistrar', () => {
  it('stops only the playback registered for the owner whose lifetime ends', () => {
    const controller = createVoicePlaybackController();
    const owner = new AbortController();
    const stopOwned = vi.fn();
    const stopNewer = vi.fn();
    scopePlaybackStopperRegistrar(controller.registerStopper, owner.signal)(stopOwned);
    controller.registerStopper(stopNewer);

    owner.abort();

    expect(stopOwned).toHaveBeenCalledTimes(1);
    expect(stopNewer).not.toHaveBeenCalled();
    // The ended owner's playback is no longer tracked by the shared controller.
    controller.interrupt();
    expect(stopOwned).toHaveBeenCalledTimes(1);
    expect(stopNewer).toHaveBeenCalledTimes(1);
  });

  it('stops a playback registered after its owner already ended, without tracking it', () => {
    const controller = createVoicePlaybackController();
    const owner = new AbortController();
    owner.abort();
    const stopper = vi.fn();

    scopePlaybackStopperRegistrar(controller.registerStopper, owner.signal)(stopper);

    expect(stopper).toHaveBeenCalledTimes(1);
    controller.interrupt();
    expect(stopper).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared interrupt and stops each playback once', () => {
    const controller = createVoicePlaybackController();
    const owner = new AbortController();
    const stopper = vi.fn();
    scopePlaybackStopperRegistrar(controller.registerStopper, owner.signal)(stopper);

    controller.interrupt();
    owner.abort();

    expect(stopper).toHaveBeenCalledTimes(1);
  });

  it('does not stop a playback that already finished and cleared itself', () => {
    const controller = createVoicePlaybackController();
    const owner = new AbortController();
    const stopper = vi.fn();
    const clear = scopePlaybackStopperRegistrar(controller.registerStopper, owner.signal)(stopper);
    clear();

    owner.abort();
    controller.interrupt();

    expect(stopper).not.toHaveBeenCalled();
  });
});
