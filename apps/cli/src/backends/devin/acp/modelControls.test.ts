import { describe, expect, it } from 'vitest';

import type { SessionConfigOption, SessionModelState } from '@/agent/acp/AcpBackend';

import {
  buildDevinSessionModelsFromConfigOptions,
  devinSessionModelAdapter,
  resolveDevinSessionConfigOptionUpdate,
  resolveDevinSessionModelConfigUpdate,
} from './modelControls';

describe('devinSessionModelAdapter', () => {
  it('distinguishes an empty model choice catalog from an absent or malformed one', () => {
    const modelOption = { id: 'model', name: 'Model', type: 'select', currentValue: 'swe-2' };
    expect(buildDevinSessionModelsFromConfigOptions([modelOption])).toBeNull();
    expect(buildDevinSessionModelsFromConfigOptions([{ ...modelOption, options: [{ value: '', name: '' }] }])).toBeNull();
    expect(buildDevinSessionModelsFromConfigOptions([{ ...modelOption, options: [] }])).toEqual({
      currentModelId: 'swe-2', availableModels: [],
    });
  });

  const rawState: SessionModelState = {
    currentModelId: 'swe-2-max',
    availableModels: [
      { id: 'swe-2-medium', name: 'SWE-2 Medium' },
      { id: 'swe-2-high', name: 'SWE-2 High' },
      { id: 'swe-2-max', name: 'SWE-2 Max' },
      { id: 'swe-1-6-fast', name: 'SWE-1.6 Fast' },
    ],
  };

  it('projects lossless combined Devin identifiers as one model with reasoning_effort', () => {
    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: rawState })).toEqual({
      currentModelId: 'swe-2',
      availableModels: [
        {
          id: 'swe-2',
          name: 'SWE-2',
          modelOptions: [{
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            type: 'select',
            currentValue: 'max',
            options: [
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'max', name: 'Max' },
            ],
          }],
        },
        { id: 'swe-1-6-fast', name: 'SWE-1.6 Fast' },
      ],
    });
  });

  it('maps canonical effort and projected model selections back to advertised Devin identifiers', () => {
    const projectedState = devinSessionModelAdapter.projectModelState?.({ normalizedModelState: rawState }) ?? null;

    expect(devinSessionModelAdapter.resolveConfigOptionModelUpdate?.({
      configId: 'reasoning_effort',
      value: 'high',
      modelState: projectedState,
    })).toEqual({ modelId: 'swe-2-high' });
    expect(devinSessionModelAdapter.resolveModelUpdate?.({
      modelId: 'swe-2',
      modelState: projectedState,
    })).toEqual({ modelId: 'swe-2-max' });
  });

  it('projects complete Devin effort and speed variants into two model options', () => {
    const state: SessionModelState = {
      currentModelId: 'gpt-5-6-sol-high-priority',
      availableModels: [
        { id: 'gpt-5-6-sol-low', name: 'GPT-5.6 Sol Low Thinking' },
        { id: 'gpt-5-6-sol-high', name: 'GPT-5.6 Sol High Thinking' },
        { id: 'gpt-5-6-sol-low-priority', name: 'GPT-5.6 Sol Low Thinking Fast' },
        { id: 'gpt-5-6-sol-high-priority', name: 'GPT-5.6 Sol High Thinking Fast' },
      ],
    };

    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state })).toMatchObject({
      currentModelId: 'gpt-5-6-sol',
      availableModels: [
        {
          id: 'gpt-5-6-sol',
          name: 'GPT-5.6 Sol',
          modelOptions: [
            {
              id: 'reasoning_effort',
              currentValue: 'high',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
            {
              id: 'service_tier',
              name: 'Speed',
              currentValue: 'priority',
              options: [
                { value: 'standard', name: 'Standard' },
                { value: 'priority', name: 'Fast' },
              ],
            },
          ],
        },
      ],
    });

    const projectedState = devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state }) ?? null;
    expect(devinSessionModelAdapter.resolveConfigOptionModelUpdate?.({
      configId: 'service_tier',
      value: 'standard',
      modelState: projectedState,
    })).toEqual({ modelId: 'gpt-5-6-sol-high' });
    expect(devinSessionModelAdapter.resolveConfigOptionModelUpdate?.({
      configId: 'reasoning_effort',
      value: 'low',
      modelState: projectedState,
    })).toEqual({ modelId: 'gpt-5-6-sol-low-priority' });
  });

  it('keeps speed variants separate when Devin does not advertise the full option matrix', () => {
    const state: SessionModelState = {
      currentModelId: 'gpt-5-6-sol-high-priority',
      availableModels: [
        { id: 'gpt-5-6-sol-low', name: 'GPT-5.6 Sol Low Thinking' },
        { id: 'gpt-5-6-sol-high', name: 'GPT-5.6 Sol High Thinking' },
        { id: 'gpt-5-6-sol-high-priority', name: 'GPT-5.6 Sol High Thinking Fast' },
      ],
    };

    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state })).toMatchObject({
      currentModelId: 'gpt-5-6-sol-high-priority',
      availableModels: [
        {
          id: 'gpt-5-6-sol',
          name: 'GPT-5.6 Sol',
          modelOptions: [{ id: 'reasoning_effort' }],
        },
        { id: 'gpt-5-6-sol-high-priority', name: 'GPT-5.6 Sol High Thinking Fast' },
      ],
    });
  });

  it('uses Devin fast suffixes as provider-native Speed values', () => {
    const state: SessionModelState = {
      currentModelId: 'claude-opus-5-high-fast',
      availableModels: [
        { id: 'claude-opus-5-low', name: 'Claude Opus 5 Low' },
        { id: 'claude-opus-5-high', name: 'Claude Opus 5 High' },
        { id: 'claude-opus-5-low-fast', name: 'Claude Opus 5 Low Fast' },
        { id: 'claude-opus-5-high-fast', name: 'Claude Opus 5 High Fast' },
      ],
    };
    const projected = devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state }) ?? null;

    expect(projected).toMatchObject({
      currentModelId: 'claude-opus-5',
      availableModels: [{
        id: 'claude-opus-5',
        modelOptions: [{ id: 'reasoning_effort' }, {
          id: 'service_tier',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        }],
      }],
    });
    expect(devinSessionModelAdapter.resolveConfigOptionModelUpdate?.({
      configId: 'service_tier',
      value: 'standard',
      modelState: projected,
    })).toEqual({ modelId: 'claude-opus-5-high' });
  });

  it('keeps single-effort speed variants separate because their raw ids cannot be reconstructed', () => {
    const state: SessionModelState = {
      currentModelId: 'single-high-fast',
      availableModels: [
        { id: 'single-high', name: 'Single High' },
        { id: 'single-high-fast', name: 'Single High Fast' },
      ],
    };

    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state }))
      .toEqual(state);
  });

  it('does not invent controls for identifiers that cannot be mapped losslessly', () => {
    const state: SessionModelState = {
      currentModelId: 'swe-1-7',
      availableModels: [
        { id: 'swe-1-7', name: 'SWE-1.7 Max' },
        { id: 'swe-1-7-medium', name: 'SWE-1.7 Medium' },
      ],
    };

    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state })).toEqual(state);
  });

  it('does not collapse variants onto an existing Devin model identifier', () => {
    const state: SessionModelState = {
      currentModelId: 'glm-5-2-max',
      availableModels: [
        { id: 'glm-5-2-high', name: 'GLM-5.2 High' },
        { id: 'glm-5-2', name: 'GLM-5.2' },
        { id: 'glm-5-2-none', name: 'GLM-5.2 No Thinking' },
        { id: 'glm-5-2-max', name: 'GLM-5.2 Max' },
      ],
    };

    expect(devinSessionModelAdapter.projectModelState?.({ normalizedModelState: state })).toEqual(state);
  });

  it('projects and reverses the model config option used by Devin ACP sessions', () => {
    const configOptions: SessionConfigOption[] = [{
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'swe-2-high',
      options: [
        { value: 'swe-2-medium', name: 'SWE-2 Medium' },
        { value: 'swe-2-high', name: 'SWE-2 High' },
        { value: 'swe-2-max', name: 'SWE-2 Max' },
      ],
    }];

    expect(buildDevinSessionModelsFromConfigOptions(configOptions)).toMatchObject({
      currentModelId: 'swe-2',
      availableModels: [{
        id: 'swe-2',
        modelOptions: [{ id: 'reasoning_effort', currentValue: 'high' }],
      }],
    });
    expect(resolveDevinSessionModelConfigUpdate({ modelId: 'swe-2', configOptions }))
      .toEqual({ modelId: 'swe-2-high' });
    expect(resolveDevinSessionConfigOptionUpdate({
      configId: 'reasoning_effort',
      value: 'max',
      configOptions,
    })).toEqual({ modelId: 'swe-2-max' });
  });
});
