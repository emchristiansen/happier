import { describe, expect, it } from 'vitest';

import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applyObservedAcpModelOptions, normalizeConfigOptionsArray, publishAcpSessionModelsState } from './sessionModelsState';

describe('normalizeConfigOptionsArray', () => {
  it('preserves exact nonblank config identifiers and values', () => {
    expect(normalizeConfigOptionsArray([{
      id: ' effort ',
      name: 'Effort',
      type: 'select',
      currentValue: ' high ',
      options: [
        { value: ' high ', name: 'High exact' },
        { value: 'high', name: 'High distinct' },
      ],
    }])).toEqual([{
      id: ' effort ',
      name: 'Effort',
      type: 'select',
      currentValue: ' high ',
      options: [
        { value: ' high ', name: 'High exact' },
        { value: 'high', name: 'High distinct' },
      ],
    }]);
  });
});

describe('publishAcpSessionModelsState', () => {
  it('publishes current model options without renewing an explicit catalog observation time', () => {
    const { session, getMetadata } = createSessionClientWithMetadata();
    for (const currentValue of ['medium', 'high']) {
      publishAcpSessionModelsState({
        session, provider: 'pi',
        payload: {
          currentModelId: 'example/model', observedAt: 42,
          availableModels: [{ id: 'example/model', name: 'Model', modelOptions: [{
            id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue,
          }] }],
        },
        logPrefix: '[test]', reason: 'session_models_state',
      });
    }
    expect(getMetadata().sessionModelsV1).toMatchObject({
      updatedAt: 42,
      availableModels: [{ modelOptions: [{ currentValue: 'high' }] }],
    });
    expect(getMetadata().acpSessionModelsV1).toEqual(getMetadata().sessionModelsV1);
  });

  it('publishes initial current-model telemetry without claiming a catalog observation', () => {
    const { session, getMetadata } = createSessionClientWithMetadata();
    publishAcpSessionModelsState({
      session, provider: 'pi', payload: { currentModelId: 'provider/current' },
      logPrefix: '[test]', reason: 'current_model_update', preservePreviousAvailableModels: true,
    });
    expect(getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'provider/current', availableModels: [], updatedAt: 0,
    });
    expect(getMetadata().acpSessionModelsV1).toEqual(getMetadata().sessionModelsV1);
  });

  it('replaces a prior catalog with successful empty membership while ignoring malformed observations', () => {
    const previous = {
      v: 1 as const, provider: 'gemini', updatedAt: 20, currentModelId: 'old',
      availableModels: [{ id: 'old', name: 'Old' }],
    };
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata({ sessionModelsV1: previous }),
    });
    publishAcpSessionModelsState({
      session, provider: 'gemini', payload: { currentModelId: 'new', availableModels: 'invalid' },
      logPrefix: '[test]', reason: 'session_models_state', preservePreviousAvailableModels: true,
    });
    expect(getMetadata().sessionModelsV1).toEqual(previous);
    publishAcpSessionModelsState({
      session, provider: 'gemini', payload: { currentModelId: 'new', availableModels: [] },
      logPrefix: '[test]', reason: 'session_models_state', preservePreviousAvailableModels: true,
    });
    expect(getMetadata().sessionModelsV1).toMatchObject({ currentModelId: 'new', availableModels: [] });
    expect(getMetadata().sessionModelsV1).toEqual(getMetadata().acpSessionModelsV1);
  });

  it('preserves available models from the newest valid alias during partial model updates', () => {
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata({
        sessionModelsV1: {
          v: 1,
          provider: 'gemini',
          updatedAt: 20,
          currentModelId: 'gemini-new',
          availableModels: [{ id: 'gemini-new', name: 'Gemini New' }],
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'gemini',
          updatedAt: 10,
          currentModelId: 'gemini-stale',
          availableModels: [{ id: 'gemini-stale', name: 'Gemini Stale' }],
        },
      }),
    });

    publishAcpSessionModelsState({
      session,
      provider: 'gemini',
      payload: { currentModelId: 'gemini-next' },
      logPrefix: '[test]',
      reason: 'current_model_update',
      preservePreviousAvailableModels: true,
    });

    expect(getMetadata().sessionModelsV1).toMatchObject({
      updatedAt: 20,
      currentModelId: 'gemini-next',
      availableModels: [{ id: 'gemini-new', name: 'Gemini New' }],
    });
    expect(getMetadata().acpSessionModelsV1).toEqual(getMetadata().sessionModelsV1);
  });
});


describe('applyObservedAcpModelOptions', () => {
  it('uses current-session choices without retaining stale choices or changing other models', () => {
    const catalogEffort = { id: 'reasoning_effort', currentValue: 'high',
      options: [{ value: 'medium' }, { value: 'high' }] };
    const observedEffort = { id: 'reasoning_effort', currentValue: 'medium', options: [{ value: 'medium' }] };
    const thinking = { id: 'thinking', currentValue: 'on', options: [{ value: 'on' }] };
    const models = [
      { id: 'default' },
      { id: 'model-a', modelOptions: [catalogEffort, thinking] },
      { id: 'model-b', modelOptions: [catalogEffort] },
    ];
    expect(applyObservedAcpModelOptions(models, 'model-a', [observedEffort])).toEqual([
      { id: 'default' },
      { id: 'model-a', modelOptions: [observedEffort] },
      { id: 'model-b', modelOptions: [catalogEffort] },
    ]);
    expect(applyObservedAcpModelOptions(models, 'unknown-model', [observedEffort])).toEqual(models);
  });
});
