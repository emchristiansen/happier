import { describe, expect, it } from 'vitest';

import {
    CodexAppServerSteerUnavailableError,
    createCodexAppServerRpcError,
    isCodexAppServerExperimentalApiUnavailableError,
    isCodexAppServerInvalidRequestForMethodError,
    isCodexAppServerInvalidRequestMapExpectedStringError,
    isCodexAppServerInvalidParamsError,
    isCodexAppServerMethodNotFoundError,
    isCodexAppServerNoActiveTurnToSteerError,
    isCodexAppServerSteerRejectedBeforeEffectError,
    isCodexAppServerSteerRpcErrorResponse,
} from './appServerCompatibility';

function makeError(message: string, code?: number): Error {
    const error = new Error(message) as Error & { code?: number };
    if (typeof code === 'number') {
        error.code = code;
    }
    return error;
}

describe('appServerCompatibility', () => {
    it('requires the client response marker and steering method for a correlated steer rejection', () => {
        expect(isCodexAppServerSteerRpcErrorResponse(createCodexAppServerRpcError({
            method: 'turn/steer', code: -32602, message: 'invalid params',
        }))).toBe(true);
        expect(isCodexAppServerSteerRpcErrorResponse(Object.assign(new Error('invalid params'), {
            method: 'turn/steer', code: -32602,
        }))).toBe(false);
        expect(isCodexAppServerSteerRpcErrorResponse(new Error('invalid params'))).toBe(false);
        expect(isCodexAppServerSteerRpcErrorResponse(createCodexAppServerRpcError({
            method: 'turn/start', code: -32602, message: 'invalid params',
        }))).toBe(false);
    });

    it('classifies local steer refusal without treating it as native turn termination', () => {
        const error = new CodexAppServerSteerUnavailableError();
        expect(isCodexAppServerSteerRejectedBeforeEffectError(error)).toBe(true);
        expect(isCodexAppServerNoActiveTurnToSteerError(error)).toBe(false);
        expect(isCodexAppServerSteerRejectedBeforeEffectError(new Error(error.message))).toBe(false);
        expect(isCodexAppServerSteerRejectedBeforeEffectError(createCodexAppServerRpcError({
            method: 'turn/steer', code: -32000, message: error.message,
        }))).toBe(false);
    });

    it('retains native no-active-turn recognition only for steering', () => {
        const nativeError = createCodexAppServerRpcError({
            method: 'turn/steer', code: -32000, message: 'no active turn to steer',
        });
        expect(isCodexAppServerNoActiveTurnToSteerError(nativeError)).toBe(true);
        expect(isCodexAppServerSteerRejectedBeforeEffectError(nativeError)).toBe(true);
        expect(isCodexAppServerSteerRejectedBeforeEffectError(createCodexAppServerRpcError({
            method: 'turn/start', code: -32000, message: 'no active turn to steer',
        }))).toBe(false);
    });

    it('detects method-not-found errors by code or message', () => {
        expect(isCodexAppServerMethodNotFoundError(makeError('nope', -32601))).toBe(true);
        expect(isCodexAppServerMethodNotFoundError(makeError('Method not found'))).toBe(true);
        expect(isCodexAppServerMethodNotFoundError(makeError('Invalid params', -32602))).toBe(false);
    });

    it('detects JSON-RPC invalid-params errors by code and message fallback', () => {
        expect(isCodexAppServerInvalidParamsError(makeError('nope', -32602))).toBe(true);
        expect(isCodexAppServerInvalidParamsError(makeError('Invalid params: unknown field permissions'))).toBe(true);
        expect(isCodexAppServerInvalidParamsError(makeError('Method not found', -32601))).toBe(false);
    });

    it('detects experimental API gating errors without treating all invalid params as gated', () => {
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('experimental API is not enabled', -32602))).toBe(true);
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('unknown experimental method', -32601))).toBe(true);
        expect(isCodexAppServerExperimentalApiUnavailableError(makeError('Invalid params: missing field'))).toBe(false);
    });

    it('detects invalid-request errors for a specific app-server method only', () => {
        expect(isCodexAppServerInvalidRequestForMethodError(makeError('request failed', -32600), 'thread/goal/set')).toBe(false);
        expect(isCodexAppServerInvalidRequestForMethodError({ code: -32600, method: 'thread/goal/set' }, 'thread/goal/set')).toBe(true);
        expect(isCodexAppServerInvalidRequestForMethodError(makeError('Invalid request: thread/goal/set', -32600), 'thread/goal/set')).toBe(true);
        expect(isCodexAppServerInvalidRequestForMethodError({ code: -32600, method: 'thread/goal/get' }, 'thread/goal/set')).toBe(false);
    });

    it('detects legacy app-server map/string permission-profile shape errors narrowly', () => {
        expect(isCodexAppServerInvalidRequestMapExpectedStringError(makeError('Invalid request: invalid type: map, expected a string', -32600))).toBe(true);
        expect(isCodexAppServerInvalidRequestMapExpectedStringError(makeError('Invalid request: invalid type: map, expected a string', -32602))).toBe(false);
        expect(isCodexAppServerInvalidRequestMapExpectedStringError(makeError('Invalid request: invalid type: array, expected a string', -32600))).toBe(false);
    });
});
