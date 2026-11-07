import { describe, expect, it } from 'vitest';

import {
  createSetupCliChoicePromptData,
  createSetupPairingPromptData,
  createSetupServiceConsentPromptData,
  parseSetupCliChoicePromptData,
  parseSetupPairingPromptData,
  readSetupCliChoiceAnswer,
  parseSetupServiceConsentPromptData,
  SETUP_PAIRING_PROMPT_KIND,
  SETUP_SERVICE_CONSENT_PROMPT_KIND,
} from './setupThisComputerTaskContract.js';

describe('setup.thisComputer.v1 prompt contract', () => {
  it('parses what it builds, and classifies the CLI facts it does not recognise', () => {
    const data = createSetupPairingPromptData({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay.example.test',
      serverIdentityKey: 'https://relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'override',
      cliCommand: '/repo/apps/cli/bin/happier.mjs',
    });

    expect(data.kind).toBe(SETUP_PAIRING_PROMPT_KIND);
    expect(parseSetupPairingPromptData(data)).toEqual({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay.example.test',
      serverIdentityKey: 'https://relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'override',
      cliCommand: '/repo/apps/cli/bin/happier.mjs',
    });

    // A requirement this contract does not know must reach the reader as `unsupported`, never as
    // a value it might treat as pairable.
    expect(parseSetupPairingPromptData(createSetupPairingPromptData({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay.example.test',
      serverIdentityKey: 'https://relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'v9',
      cliProvenance: 'managed',
      cliCommand: '/home/u/.happier/cli/current/happier',
    }))?.pairingRequirement).toBe('unsupported');
  });

  it('never carries relay-url credentials into the prompt the runner turns into an event', () => {
    // The runner redacts by key name (`/secret|token|password|statefile/i`), and `relayUrl` is not
    // one of those names, so a `https://user:pass@host` relay would reach event snapshots and logs
    // verbatim. The builder is the one producer of this payload, so it strips userinfo here.
    const data = createSetupPairingPromptData({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay-user:relay-pass@relay.example.test/base',
      serverIdentityKey: 'https://relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'managed',
      cliCommand: '/home/u/.happier/cli/current/happier',
    });

    expect(parseSetupPairingPromptData(data)?.relayUrl).toBe('https://relay.example.test/base');
    expect(JSON.stringify(data)).not.toContain('relay-pass');
    expect(JSON.stringify(data)).not.toContain('relay-user');
  });

  it('rejects a foreign, incomplete or malformed pairing payload instead of guessing', () => {
    const complete = createSetupPairingPromptData({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: 'https://relay.example.test',
      serverIdentityKey: 'https://relay.example.test',
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'managed',
      cliCommand: '/home/u/.happier/cli/current/happier',
    });

    expect(parseSetupPairingPromptData({ ...complete, kind: 'authRequest' })).toBeNull();
    expect(parseSetupPairingPromptData({ ...complete, publicKeyB64Url: '  ' })).toBeNull();
    expect(parseSetupPairingPromptData({ ...complete, relayUrl: 42 })).toBeNull();
    // The CLI's own key for the relay it configured is the fact the app compares; without it
    // there is nothing to approve against.
    expect(parseSetupPairingPromptData({ ...complete, serverIdentityKey: undefined })).toBeNull();
    expect(parseSetupPairingPromptData(null)).toBeNull();
    expect(parseSetupPairingPromptData([complete])).toBeNull();

    // An unknown provenance is never read as managed; the approval owner refuses on that.
    expect(parseSetupPairingPromptData({ ...complete, cliProvenance: 'trusted' })?.cliProvenance).toBeNull();

    // A prompt that does not name the account it is pairing for reaches the reader as `null`, so
    // the approval owner refuses it by name instead of approving an unbound pairing.
    expect(parseSetupPairingPromptData({ ...complete, accountId: undefined })?.accountId).toBeNull();
    expect(parseSetupPairingPromptData({ ...complete, accountId: 7 })?.accountId).toBeNull();

    // The resolved command is what a human is shown when asked to vouch for an override CLI; an
    // executor that named none reaches the reader as `null` rather than as a guessed path.
    expect(parseSetupPairingPromptData({ ...complete, cliCommand: undefined })?.cliCommand).toBeNull();
  });

  it('carries the service-consent facts and rejects a payload of another kind', () => {
    const data = createSetupServiceConsentPromptData({
      takeover: 'Taking over the current manual daemon.',
      message: null,
      competingServices: ['happier-preview'],
      servicesToRemove: [],
      runtimeReplacement: null,
    });

    expect(data.kind).toBe(SETUP_SERVICE_CONSENT_PROMPT_KIND);
    expect(parseSetupServiceConsentPromptData(data)).toEqual({
      takeover: 'Taking over the current manual daemon.',
      message: null,
      competingServices: ['happier-preview'],
      servicesToRemove: [],
      runtimeReplacement: null,
    });
    expect(parseSetupServiceConsentPromptData({ ...data, kind: SETUP_PAIRING_PROMPT_KIND })).toBeNull();
    expect(parseSetupServiceConsentPromptData({ ...data, competingServices: 'happier-preview' })?.competingServices).toEqual([]);
  });

  it('carries which CLI the service runs now and which one installing switches it to (K3)', () => {
    const data = createSetupServiceConsentPromptData({
      takeover: null,
      message: 'The background service runs /usr/local/bin/happier.',
      competingServices: [],
      servicesToRemove: [],
      runtimeReplacement: { current: '/usr/local/bin/happier', replacement: '/Users/me/.happier/bin/happier' },
    });

    expect(parseSetupServiceConsentPromptData(data)?.runtimeReplacement).toEqual({
      current: '/usr/local/bin/happier',
      replacement: '/Users/me/.happier/bin/happier',
    });
    // An older executor sends no replacement; a malformed one is not guessed at.
    expect(parseSetupServiceConsentPromptData({ ...data, runtimeReplacement: undefined })?.runtimeReplacement).toBeNull();
    expect(parseSetupServiceConsentPromptData({ ...data, runtimeReplacement: { current: '' } })?.runtimeReplacement).toBeNull();
  });

  it('names the CLI the one-CLI question is about, and reads only a stated answer (R12)', () => {
    const data = createSetupCliChoicePromptData({
      command: '/usr/local/bin/happier',
      version: '0.2.13',
      origin: 'npm',
      removalCommand: 'npm uninstall -g @happier-dev/cli',
      updateCommand: 'npm install -g @happier-dev/cli@latest',
      belowSetupFloor: false,
      missing: false,
      keepBlockedBy: null,
    });

    expect(parseSetupCliChoicePromptData(data)).toEqual({
      command: '/usr/local/bin/happier',
      version: '0.2.13',
      origin: 'npm',
      removalCommand: 'npm uninstall -g @happier-dev/cli',
      updateCommand: 'npm install -g @happier-dev/cli@latest',
      belowSetupFloor: false,
      missing: false,
      keepBlockedBy: null,
    });
    // R13 (b): a kept CLI that disappeared is asked about by the path it was at.
    expect(parseSetupCliChoicePromptData(createSetupCliChoicePromptData({
      command: '/usr/local/bin/happier',
      version: null,
      origin: 'unknown',
      removalCommand: null,
      updateCommand: null,
      belowSetupFloor: true,
      missing: true,
      keepBlockedBy: '/home/me/.local/bin/happier',
    }))).toMatchObject({ command: '/usr/local/bin/happier', version: null, missing: true, keepBlockedBy: '/home/me/.local/bin/happier' });
    expect(parseSetupCliChoicePromptData({ ...data, origin: 'pip' })?.origin).toBe('unknown');
    expect(parseSetupCliChoicePromptData({ ...data, command: '' })).toBeNull();

    expect(readSetupCliChoiceAnswer({ choice: 'managed' })).toBe('managed');
    expect(readSetupCliChoiceAnswer({ choice: 'own' })).toBe('own');
    // A dismissed question is no answer, never "keep".
    expect(readSetupCliChoiceAnswer({ approved: false })).toBeNull();
    expect(readSetupCliChoiceAnswer(null)).toBeNull();
  });
});
