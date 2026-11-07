import type { IModal } from '@/modal';
import { describe, expect, it, vi } from 'vitest';

const showModalMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));
const browserModuleGate = vi.hoisted(() => ({
    block: false,
    release: null as (() => void) | null,
    onRequested: null as (() => void) | null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: showModalMock,
        },
    }).module;
});

vi.mock('./MachinePathBrowserModal', async () => {
    browserModuleGate.onRequested?.();
    if (browserModuleGate.block) {
        await new Promise<void>((resolve) => {
            browserModuleGate.release = resolve;
        });
    }
    return { MachinePathBrowserModal: () => null };
});

describe('openMachinePathBrowserModal', () => {
    it('can show the modal shell without loading the path browser implementation first', async () => {
        await import('./openMachinePathBrowserModal');
        vi.resetModules();
        browserModuleGate.block = true;
        // Decide on module-graph order, not wall-clock: loading the opener's shared graph (the
        // spinner, stores) can take seconds on a busy runner, but it must finish without ever
        // requesting the path browser implementation.
        const browserRequested = new Promise<'browser-requested'>((resolve) => {
            browserModuleGate.onRequested = () => resolve('browser-requested');
        });
        const openerLoaded = import('./openMachinePathBrowserModal').then(() => 'opener-loaded' as const);

        try {
            expect(await Promise.race([openerLoaded, browserRequested])).toBe('opener-loaded');
        } finally {
            browserModuleGate.onRequested = null;
            browserModuleGate.release?.();
        }
    });

    it('opens the path browser with shared modal-card chrome so contained native modals own the sizing frame', async () => {
        const { openMachinePathBrowserModal } = await import('./openMachinePathBrowserModal');

        const promise = openMachinePathBrowserModal({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
        });

        expect(showModalMock).toHaveBeenCalledTimes(1);
        const firstCall = showModalMock.mock.calls[0];
        if (!firstCall) {
            throw new Error('Expected Modal.show to be called');
        }
        const config = firstCall[0] as {
            chrome?: unknown;
            component?: unknown;
            props?: Record<string, unknown>;
            onRequestClose?: () => void;
        };

        expect(config.chrome).toEqual(expect.objectContaining({
            kind: 'card',
            dimensions: expect.objectContaining({ maxHeightRatio: 0.92 }),
        }));
        expect(config.component).toBeTypeOf('function');
        expect(config.props).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
            selectionMode: 'directory',
        }));

        config.onRequestClose?.();
        await expect(promise).resolves.toBeNull();
    });
});
