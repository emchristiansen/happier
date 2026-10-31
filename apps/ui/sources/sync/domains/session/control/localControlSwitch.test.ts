import { describe, expect, it } from 'vitest';
import {
  shouldRenderChatTimelineForSession,
  shouldRequestRemoteControl,
  shouldRequestRemoteControlAfterPendingEnqueue,
  shouldOfferLocalControlRelease,
} from './localControlSwitch';
import type { Session } from '@/sync/domains/state/storageTypes';
import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import { createSessionFixture } from '@/dev/testkit';

describe('localControlSwitch', () => {
  it('allows explicit release of the managed shared terminal without exclusive switching or model authentication', () => {
    const session = createSessionFixture({ active: true, agentState: { controlledByUser: false, localControl: {
      attached: true, topology: 'shared', remoteWritable: true, canDetach: true,
    } } });
    expect(shouldOfferLocalControlRelease(session, 'logged_out')).toBe(true);
    expect(shouldRequestRemoteControl(session, 'logged_out')).toBe(false);
    expect(shouldRequestRemoteControlAfterPendingEnqueue(session, 'logged_out')).toBe(false);
  });

  it.each([false, undefined])('does not offer shared release without runner custody (%s)', (canDetach) => {
    const session = createSessionFixture({ active: true, agentState: { controlledByUser: false, localControl: {
      attached: true, topology: 'shared', remoteWritable: true, ...(canDetach === undefined ? {} : { canDetach }),
    } } });
    expect(shouldOfferLocalControlRelease(session, 'logged_in')).toBe(false);
  });

  it('renders the existing zero-turn timeline for a shared local attachment', async () => {
    const { isSessionLocallyAttached } = await import('./sessionLocalControl');
    const session = createSessionFixture({ active: true, agentState: { controlledByUser: false, localControl: {
      attached: true, topology: 'shared', remoteWritable: true, canDetach: true,
    } } });
    expect(shouldRenderChatTimelineForSession({ committedMessagesCount: 0, pendingMessagesCount: 0,
      controlledByUser: isSessionLocallyAttached(session) })).toBe(true);
  });

  function connectedSession(connectedServices: unknown, flavor = 'claude'): Session {
    return createSessionFixture({
      active: true,
      metadata: MetadataSchema.parse({ path: '/workspace', host: 'machine', flavor, connectedServices }),
      agentState: { controlledByUser: true },
    });
  }

  it.each([
    { source: 'connected', selection: 'profile', profileId: 'work' },
    { source: 'connected', selection: 'group', groupId: 'work-pool' },
  ])('does not mistake ambient logout for the selected connected authentication ($selection)', (binding) => {
    const session = connectedSession({ v: 1, bindingsByServiceId: { 'claude-subscription': binding } });
    expect(shouldRequestRemoteControl(session, 'logged_out')).toBe(true);
    expect(shouldRequestRemoteControlAfterPendingEnqueue(session, 'logged_out')).toBe(true);
  });

  it('uses the actual Session provider catalog rather than a Claude-specific authentication exception', () => {
    const session = connectedSession({
      v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
    }, 'codex');
    expect(shouldRequestRemoteControl(session, 'logged_out')).toBe(true);
  });

  it.each([
    { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'unrelated' } } },
    { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'native' } } },
    { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected' } } },
    { v: 2, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } } },
    undefined,
  ])('keeps ambient logout blocking for unrelated, native, absent or malformed selections (%#)', (bindings) => {
    expect(shouldRequestRemoteControl(connectedSession(bindings), 'logged_out')).toBe(false);
  });

  it('does not infer an unknown Session provider from a connected service selection', () => {
    const session = connectedSession({
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
    }, 'unknown-provider');
    expect(shouldRequestRemoteControl(session, 'logged_out')).toBe(false);
  });

  it('preserves exclusive-local eligibility for connected authentication', () => {
    const session = connectedSession({
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
    });
    session.agentState = { controlledByUser: false, localControl: { attached: true, topology: 'shared', remoteWritable: true } };
    expect(shouldRequestRemoteControl(session, 'logged_out')).toBe(false);
    expect(shouldRequestRemoteControlAfterPendingEnqueue(session, 'logged_out')).toBe(false);
  });

  it('does not request remote control when session is null', () => {
    expect(shouldRequestRemoteControlAfterPendingEnqueue(null)).toBe(false);
  });

  it('requests remote control after pending enqueue when session is controlled by user', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        active: true,
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session),
    ).toBe(true);
  });

  it('does not request remote control when the CLI auth state is logged out', () => {
    expect(
      shouldRequestRemoteControl({
        active: true,
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session, 'logged_out'),
    ).toBe(false);
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        active: true,
        presence: 'online',
        agentState: { controlledByUser: true },
      } as Session, 'logged_out'),
    ).toBe(false);
  });

  it('does not request remote control when session is not controlled by user', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: { controlledByUser: false },
      } as Session),
    ).toBe(false);
  });

  it('does not request remote control after pending enqueue for shared local attachment', () => {
    expect(
      shouldRequestRemoteControlAfterPendingEnqueue({
        presence: 'online',
        agentState: {
          controlledByUser: false,
          localControl: {
            attached: true,
            topology: 'shared',
            remoteWritable: true,
          },
        },
      } as Session),
    ).toBe(false);
  });

  it('renders the chat timeline when a session is controlled by user even with no messages yet', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: true,
      }),
    ).toBe(true);
  });

  it('renders the chat timeline when the footer must be shown even with no messages yet', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: false,
        forceRenderFooter: true,
      }),
    ).toBe(true);
  });

  it('does not render an empty chat timeline just to expose remote-to-local attachment UI', () => {
    expect(
      shouldRenderChatTimelineForSession({
        committedMessagesCount: 0,
        pendingMessagesCount: 0,
        controlledByUser: false,
      }),
    ).toBe(false);
  });
});
