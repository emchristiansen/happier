import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ActionOperationSnapshotV1Schema, SessionHandoffStartResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';
import type { SessionHandoffPickerModalProps } from './SessionHandoffPickerModal';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => {
    const { createServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcModuleMock({ importOriginal, overrides: { machineRpcWithServerScope: machineRpc } });
});
const modal = createModalModuleMock();
installSessionHandoffCommonModuleMocks({ storage: async (importOriginal) => importOriginal(), modal: async () => modal.module });
vi.doUnmock('@/constants/Typography');
let cleanup = () => {};
afterEach(() => cleanup());

it('keeps the dialog after no-copy refusal and sends only the corrected transfer choice on retry', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const previousState = storage.getState();
    const previousAccountId = sync.serverID;
    cleanup = () => { storage.setState(previousState, true); sync.serverID = previousAccountId; };
    sync.serverID = 'handoff-test-account';
    let nextModalId = 0;
    modal.spies.show.mockImplementation(() => `handoff-modal-${++nextModalId}`);
    storage.getState().applySessions([createSessionFixture({ id: 'handoff-test-session', active: false, metadata: { ...createSessionFixture().metadata!, machineId: 'handoff-test-source', path: '/project', flavor: 'claude' } })]);
    machineRpc.mockResolvedValue({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Native session unavailable' });
    const outputPath = process.env.HAPPIER_HANDOFF_FAILURE_TEST_OUTPUT;
    let expectedError = 'Native session unavailable';
    if (outputPath) {
        const produced: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
        if (!produced || typeof produced !== 'object' || !('admission' in produced) || !('terminal' in produced)) throw new Error('Daemon handoff composition output is missing');
        const admission = SessionHandoffStartResponseSchema.parse(produced.admission);
        const terminal = ActionOperationSnapshotV1Schema.parse(produced.terminal);
        expect(terminal.error?.errorCode).toBe('existing_session_state_unavailable');
        if ('launchFailure' in produced) {
            expect(produced.launchFailure).toMatchObject({ type: 'error', errorCode: terminal.error?.errorCode, errorMessage: terminal.error?.error });
        }
        if (!terminal.error?.error) throw new Error('Daemon failure explanation is missing');
        expectedError = terminal.error.error;
        const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
        // The RPC/socket transport rebinds the producer fixture's correlation to this App request.
        machineRpc.mockImplementation(async ({ method, payload }) => {
            if (method !== RPC_METHODS.DAEMON_SESSION_HANDOFF_START) throw new Error(`Unexpected RPC ${method}`);
            actionOperationStore.merge(ActionOperationSnapshotV1Schema.parse({
                ...terminal, operationId: payload.requestId, requestId: payload.requestId,
                scope: { accountId: sync.serverID, machineId: payload.sourceMachineId, sessionId: payload.sessionId },
            }));
            return admission;
        });
    }
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { runSessionHandoffPickerFlow } = await import('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow');
    const executor = createDefaultActionExecutor();
    const actionResults: unknown[] = [];
    const execute: typeof executor.execute = async (...args) => {
        const result = await executor.execute(...args);
        actionResults.push(result);
        return result;
    };
    const flow = runSessionHandoffPickerFlow({ execute, sessionId: 'handoff-test-session', sourceMachineId: 'handoff-test-source', serverId: null, placement: 'session_info' });
    await vi.waitFor(() => expect(modal.spies.show).toHaveBeenCalled());
    const config = modal.spies.show.mock.calls[0]?.[0] as { props: Omit<SessionHandoffPickerModalProps, 'onClose' | 'setChrome'> };
    config.props.onResolve({ targetMachineId: 'handoff-test-target', stateTransfer: 'existing' });
    await expect(flow).resolves.toMatchObject({ ok: false, handled: true });
    expect(actionResults[0]).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable', error: expectedError });
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START, payload: expect.objectContaining({ stateTransfer: 'existing' }) }));
    expect(modal.spies.update).toHaveBeenCalledWith('handoff-modal-1', { inlineErrorCode: 'existing_session_state_unavailable' });
    expect(modal.spies.hide).not.toHaveBeenCalledWith('handoff-modal-1');
    config.props.onResolve({ targetMachineId: 'handoff-test-target', stateTransfer: 'transfer' });
    await vi.waitFor(() => expect(machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_START)).toHaveLength(2));
    expect(machineRpc.mock.lastCall?.[0].payload.stateTransfer).not.toBe('existing');
    expect(modal.spies.update).toHaveBeenCalledWith('handoff-modal-1', { inlineErrorCode: null });
    config.props.onResolve(null);
});
