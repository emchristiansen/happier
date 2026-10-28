import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedPromptInjector } from './createClaudeUnifiedPromptInjector';

describe('createClaudeUnifiedPromptInjector', () => {
  it('maps the internal goal-control origin onto the terminal RPC transport origin', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 11,
    });
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'goal-nonce',
    });

    await expect(
      injector.injectPrompt({
        message: '/goal clear',
        origin: { kind: 'goal_control' },
      }),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(injectUserPrompt).toHaveBeenCalledWith(expect.objectContaining({
      origin: {
        kind: 'rpc',
        clientId: undefined,
        nonce: 'goal-nonce',
      },
    }));
  });

  it('injects Claude multiline prompts without bracketed paste markers', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 17,
    });
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
    });

    await expect(
      injector.injectPrompt({
        message: 'alpha\nbeta',
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(injectUserPrompt).toHaveBeenCalledWith({
      text: 'alpha\nbeta',
      multiline: true,
      origin: {
        kind: 'ui_pending',
        clientId: 'client-1',
        nonce: 'nonce-1',
      },
      scheduling: {
        deferredUntilQuietMs: 800,
        timeoutMs: 15_000,
      },
    });
  });

  it('normalizes CR and CRLF prompt line endings before injection', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 17,
    });
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
    });

    await expect(
      injector.injectPrompt({
        message: 'alpha\r\nbeta\rgamma',
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(injectUserPrompt).toHaveBeenCalledWith({
      text: 'alpha\nbeta\ngamma',
      multiline: true,
      origin: {
        kind: 'ui_pending',
        clientId: 'client-1',
        nonce: 'nonce-1',
      },
      scheduling: {
        deferredUntilQuietMs: 800,
        timeoutMs: 15_000,
      },
    });
  });

  it('scales the terminal write timeout for large prompts', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 128_000,
    });
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
    });

    await expect(
      injector.injectPrompt({
        message: 'x'.repeat(128_000),
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(injectUserPrompt).toHaveBeenCalledWith(expect.objectContaining({
      scheduling: expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    }));
    const input = injectUserPrompt.mock.calls[0]?.[0];
    expect(input?.scheduling.timeoutMs).toBeGreaterThan(15_000);
  });

  it('rejects terminal control bytes before prompt text reaches the terminal injector', async () => {
    const unsafePrompts = [
      ['nul', 'alpha\x00beta'],
      ['ctrl-c', 'alpha\x03beta'],
      ['ctrl-d', 'alpha\x04beta'],
      ['escape', 'alpha\x1bbeta'],
      ['csi', 'alpha\x1b[31mbeta'],
      ['osc', 'alpha\x1b]0;title\x07beta'],
      ['bracketed-paste-start', 'alpha\x1b[200~beta'],
      ['bracketed-paste-end', 'alpha\x1b[201~beta'],
    ] as const;

    for (const [caseName, message] of unsafePrompts) {
      const injectUserPrompt = vi.fn().mockResolvedValue({
        status: 'injected',
        at: 123,
        bytesWritten: 17,
      });
      const onInjected = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: {
          hostKind: 'zellij',
          injectUserPrompt,
        },
        createNonce: () => `nonce-${caseName}`,
        onInjected,
      });

      await expect(
        injector.injectPrompt({
          message,
          origin: { kind: 'ui_pending', clientId: 'client-1' },
        }),
      ).resolves.toEqual({
        status: 'failed',
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
      });

      expect(injectUserPrompt, caseName).not.toHaveBeenCalled();
      expect(onInjected, caseName).not.toHaveBeenCalled();
    }
  });

  it('skips quiet-screen deferral for in-flight steer injections', async () => {
    const injectUserPrompt = vi.fn().mockResolvedValue({
      status: 'injected',
      at: 123,
      bytesWritten: 8,
    });
    const telemetry = { emit: vi.fn() };
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt,
      },
      createNonce: () => 'nonce-1',
      telemetry,
    });

    await expect(
      injector.injectPrompt(
        {
          message: 'steer me',
          origin: { kind: 'ui_pending', clientId: 'client-1' },
        },
        { inFlightSteer: true },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    // A generating screen is never "quiet"; the steer-safety screen evaluation
    // already vetoed visible user drafts, so the adapter quiet-screen deferral
    // must be skipped or the steer can never be written.
    expect(injectUserPrompt).toHaveBeenCalledWith({
      text: 'steer me',
      multiline: false,
      origin: {
        kind: 'ui_pending',
        clientId: 'client-1',
        nonce: 'nonce-1',
      },
      scheduling: {
        timeoutMs: 15_000,
      },
    });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.injection.outcome',
      properties: expect.objectContaining({
        status: 'injected',
        originKind: 'ui_pending',
        inFlightSteer: true,
      }),
    });
  });

  it('emits safe injection outcome telemetry without prompt text', async () => {
    const telemetry = { emit: vi.fn() };
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: {
        hostKind: 'zellij',
        injectUserPrompt: vi.fn().mockResolvedValue({
          status: 'failed',
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
        }),
      },
      createNonce: () => 'nonce-1',
      telemetry,
    });

    await expect(
      injector.injectPrompt({
        message: 'secret prompt\nsecond line',
        origin: { kind: 'ui_pending', clientId: 'client-1' },
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead' });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.injection.outcome',
      properties: {
        status: 'failed',
        reason: 'pane_dead',
        phase: 'liveness',
        duplicateRisk: 'none',
        recoverable: false,
        hostKind: 'zellij',
        multiline: true,
        originKind: 'ui_pending',
        inputByteLength: 25,
        inputNewlineCount: 1,
        writeTimeoutMs: 15_000,
      },
    });
    expect(JSON.stringify(telemetry.emit.mock.calls)).not.toContain('secret prompt');
  });

  // C11 (live-proven, runner pid 83791): idle injection typed the new prompt AFTER a leftover
  // composer draft and submitted the concatenation. The injector must run the composer guard
  // before writing: own leftovers are cleared, genuine drafts defer the injection untouched.
  describe('composer draft guard (C11)', () => {
    it('runs the guard before writing and proceeds when the own leftover was cleared', async () => {
      const order: string[] = [];
      const injectUserPrompt = vi.fn().mockImplementation(async () => {
        order.push('inject');
        return { status: 'injected', at: 1, bytesWritten: 5 };
      });
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        beforeComposerDraftGuard: async () => {
          order.push('runtime-control');
          return null;
        },
        composerDraftGuard: async () => {
          order.push('guard');
          return { status: 'cleared', attempts: 1, draftLength: 35 };
        },
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'injected' });
      expect(order).toEqual(['runtime-control', 'guard', 'inject']);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'cleared', attempts: 1, draftLength: 35, originKind: 'ui_pending' },
      });
    });

    it('writes the queued prompt after the guard clears controller slash-command residue', async () => {
      const injectUserPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 11 });
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'cleared', attempts: 1, draftLength: '/effort medium'.length }),
        createNonce: () => 'nonce-1',
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'injected' });
      expect(injectUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ text: 'next prompt' }));
    });

    it('defers the injection without writing when the composer holds a genuine user draft', async () => {
      const injectUserPrompt = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'foreign_draft', draftLength: 12 }),
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({
        status: 'deferred',
        reason: 'user_typing',
        blocker: {
          kind: 'terminal_user_draft',
          source: 'draft_guard',
          guardStatus: 'foreign_draft',
          draftLength: 12,
        },
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'foreign_draft', draftLength: 12, originKind: 'ui_pending' },
      });
    });

    it('defers provider-unavailable guard states with the provider blocker instead of a composer-draft blocker', async () => {
      const injectUserPrompt = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'provider_unavailable' }),
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({
        status: 'deferred',
        reason: 'terminal_busy',
        retryAfterMs: 30_000,
        blocker: {
          kind: 'provider_unavailable',
          source: 'draft_guard',
          detail: 'claude_usage_limit_dialog',
        },
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'provider_unavailable', originKind: 'ui_pending' },
      });
    });

    it('defers non-input guard states as terminal busy instead of user typing', async () => {
      const injectUserPrompt = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'blocked_non_input_state', blockedReason: 'switch_model_dialog' }),
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({
        status: 'deferred',
        reason: 'terminal_busy',
        retryAfterMs: 2_000,
        blocker: {
          kind: 'terminal_busy',
          source: 'readiness',
          detail: 'switch_model_dialog',
        },
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: {
          status: 'blocked_non_input_state',
          blockedReason: 'switch_model_dialog',
          originKind: 'ui_pending',
        },
      });
    });

    // Live-proven starvation (runner pid 20327, 11:28): an idle session has no turn-end or
    // readiness wake, so a guard deferral WITHOUT retryAfterMs left the head prompt queued
    // forever (arbiter scheduleRetryDrain(undefined) arms no timer).
    it('guard deferrals carry retryAfterMs so an idle session re-attempts the injection', async () => {
      for (const guard of [
        { status: 'foreign_draft' as const, draftLength: 12 },
        { status: 'capture_style_unavailable' as const, draftLength: 12 },
        { status: 'clear_failed' as const, draftLength: 35 },
      ]) {
        const injector = createClaudeUnifiedPromptInjector({
          inputInjection: { hostKind: 'zellij', injectUserPrompt: vi.fn() },
          composerDraftGuard: async () => guard,
          createNonce: () => 'nonce-1',
        });
        const result = await injector.injectPrompt({
          message: 'next prompt',
          origin: { kind: 'ui_pending', clientId: 'c1' },
        });
        expect(result.status).toBe('deferred');
        if (result.status === 'deferred') {
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      }
    });

    it('defers with explicit telemetry when capture style is unavailable for visible composer text', async () => {
      const injectUserPrompt = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'capture_style_unavailable', draftLength: 32 }),
        createNonce: () => 'nonce-1',
        telemetry,
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({
        status: 'deferred',
        reason: 'user_typing',
        retryAfterMs: 2_000,
        blocker: {
          kind: 'capture_ambiguous',
          source: 'draft_guard',
          guardStatus: 'capture_style_unavailable',
          draftLength: 32,
        },
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: { status: 'capture_style_unavailable', draftLength: 32, originKind: 'ui_pending' },
      });
      expect(JSON.stringify(telemetry.emit.mock.calls)).not.toContain('next prompt');
    });

    it('backs off sustained guard deferrals instead of polling the terminal every two seconds indefinitely', async () => {
      let nowMs = 0;
      const injectUserPrompt = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'foreign_draft', draftLength: 12 }),
        createNonce: () => 'nonce-1',
        nowMs: () => nowMs,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await injector.injectPrompt({
          message: 'next prompt',
          origin: { kind: 'ui_pending', clientId: 'c1' },
        });
        expect(result).toMatchObject({
          status: 'deferred',
          reason: 'user_typing',
          retryAfterMs: 2_000,
        });
      }

      nowMs = 15_000;

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({
        status: 'deferred',
        reason: 'user_typing',
        retryAfterMs: 30_000,
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
    });

    it('fires one structured starvation notice for a persistent idle foreign draft blocker', async () => {
      let nowMs = 0;
      const injectUserPrompt = vi.fn();
      const onDraftGuardStarvation = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injectorOptions = {
        inputInjection: { hostKind: 'zellij' as const, injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'foreign_draft' as const, draftLength: 32 }),
        createNonce: () => 'nonce-1',
        nowMs: () => nowMs,
        telemetry,
        onDraftGuardStarvation,
        isCanonicalTurnActive: () => false,
      };
      const injector = createClaudeUnifiedPromptInjector(injectorOptions);
      const batch = { message: 'next prompt', origin: { kind: 'ui_pending' as const, clientId: 'c1' } };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await injector.injectPrompt(batch);
      }
      expect(onDraftGuardStarvation).not.toHaveBeenCalled();

      nowMs = 15_000;
      await injector.injectPrompt(batch);
      await injector.injectPrompt(batch);

      expect(onDraftGuardStarvation).toHaveBeenCalledTimes(1);
      expect(onDraftGuardStarvation).toHaveBeenCalledWith({
        consecutiveDeferrals: 4,
        draftLength: 32,
        guardStatus: 'foreign_draft',
        isCanonicalTurnActive: false,
        originKind: 'ui_pending',
        userMessageLocalIds: [],
      });
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: {
          status: 'starvation_escalated',
          consecutiveDeferrals: 4,
          draftLength: 32,
          guardStatus: 'foreign_draft',
          originKind: 'ui_pending',
        },
      });
      expect(injectUserPrompt).not.toHaveBeenCalled();
    });

    it('fires the starvation notice with capture_style_unavailable as the guard status', async () => {
      let nowMs = 0;
      const onDraftGuardStarvation = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt: vi.fn() },
        composerDraftGuard: async () => ({ status: 'capture_style_unavailable' as const, draftLength: 32 }),
        createNonce: () => 'nonce-1',
        nowMs: () => nowMs,
        onDraftGuardStarvation,
      });
      const batch = { message: 'next prompt', origin: { kind: 'ui_pending' as const, clientId: 'c1' } };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await injector.injectPrompt(batch);
      }
      nowMs = 15_000;
      await injector.injectPrompt(batch);

      expect(onDraftGuardStarvation).toHaveBeenCalledWith({
        consecutiveDeferrals: 4,
        draftLength: 32,
        guardStatus: 'capture_style_unavailable',
        isCanonicalTurnActive: true,
        originKind: 'ui_pending',
        userMessageLocalIds: [],
      });
    });

    it('escalates a sustained dialog block once after the configured duration', async () => {
      let nowMs = 0;
      const onDraftGuardStarvation = vi.fn();
      const telemetry = { emit: vi.fn() };
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt: vi.fn() },
        composerDraftGuard: async () => ({
          status: 'blocked_non_input_state' as const,
          blockedReason: 'safeguard_pause_dialog',
        }),
        createNonce: () => 'nonce-1',
        nowMs: () => nowMs,
        draftGuardStarvationThresholdMs: 1_000,
        onDraftGuardStarvation,
        telemetry,
        isCanonicalTurnActive: () => false,
      });
      const batch = {
        message: 'next prompt',
        origin: { kind: 'ui_pending' as const, clientId: 'c1' },
        userMessageLocalIds: ['pending-dialog-local'],
      };

      await injector.injectPrompt(batch);
      expect(onDraftGuardStarvation).not.toHaveBeenCalled();

      nowMs = 1_001;
      await injector.injectPrompt(batch);
      nowMs = 2_001;
      await injector.injectPrompt(batch);

      expect(onDraftGuardStarvation).toHaveBeenCalledTimes(1);
      expect(onDraftGuardStarvation).toHaveBeenCalledWith({
        consecutiveDeferrals: 2,
        guardStatus: 'blocked_non_input_state',
        blockedReason: 'safeguard_pause_dialog',
        isCanonicalTurnActive: false,
        originKind: 'ui_pending',
        userMessageLocalIds: ['pending-dialog-local'],
      });
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.injection.draft_guard',
        properties: {
          status: 'starvation_escalated',
          consecutiveDeferrals: 2,
          guardStatus: 'blocked_non_input_state',
          blockedReason: 'safeguard_pause_dialog',
          originKind: 'ui_pending',
        },
      });
    });

    it('defers without writing when the own leftover could not be cleared (never concatenates)', async () => {
      const injectUserPrompt = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard: async () => ({ status: 'clear_failed', draftLength: 35 }),
        createNonce: () => 'nonce-1',
      });

      await expect(
        injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
      ).resolves.toMatchObject({ status: 'deferred', reason: 'user_typing' });
      expect(injectUserPrompt).not.toHaveBeenCalled();
    });

    it('proceeds unchanged on no_draft, generating, and capture_failed guard outcomes', async () => {
      for (const guard of [
        { status: 'no_draft' as const },
        { status: 'generating' as const },
        { status: 'capture_failed' as const },
      ]) {
        const injectUserPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
        const injector = createClaudeUnifiedPromptInjector({
          inputInjection: { hostKind: 'zellij', injectUserPrompt },
          composerDraftGuard: async () => guard,
          createNonce: () => 'nonce-1',
        });
        await expect(
          injector.injectPrompt({ message: 'next prompt', origin: { kind: 'ui_pending', clientId: 'c1' } }),
        ).resolves.toMatchObject({ status: 'injected' });
        expect(injectUserPrompt).toHaveBeenCalledTimes(1);
      }
    });

    it('skips the guard entirely for in-flight steer injections (steer evaluator owns that screen)', async () => {
      const injectUserPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
      const composerDraftGuard = vi.fn();
      const injector = createClaudeUnifiedPromptInjector({
        inputInjection: { hostKind: 'zellij', injectUserPrompt },
        composerDraftGuard,
        createNonce: () => 'nonce-1',
      });

      await expect(
        injector.injectPrompt(
          { message: 'steer text', origin: { kind: 'ui_pending', clientId: 'c1' } },
          { inFlightSteer: true },
        ),
      ).resolves.toMatchObject({ status: 'injected' });
      expect(composerDraftGuard).not.toHaveBeenCalled();
    });
  });
});
