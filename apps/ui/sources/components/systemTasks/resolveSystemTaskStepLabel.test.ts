import { describe, expect, it } from 'vitest';

import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';

describe('resolveSystemTaskStepLabel', () => {
    it('returns null when step id is null', () => {
        expect(resolveSystemTaskStepLabel(null)).toBeNull();
    });

    it('translates known remote SSH step ids', () => {
        expect(resolveSystemTaskStepLabel('ssh.trust')).not.toBe('ssh.trust');
    });

    it('translates known relay drift repair step ids', () => {
        expect(resolveSystemTaskStepLabel('relay.drift.repair.start')).not.toBe('relay.drift.repair.start');
    });

    it('gives the setup service steps their own names instead of collapsing them into "install"', () => {
        const labels = [
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.restartService',
        ].map((stepId) => resolveSystemTaskStepLabel(stepId));

        expect(new Set(labels).size).toBe(3);
    });

    it('labels every step the local setup executor actually emits', async () => {
        // The dead rows this table used to carry (`validateTarget`, `resolveRelay`,
        // `verifyService`) were never emitted, while `serviceConsent` — a step the executor does
        // emit — had no row and showed the person the raw step id.
        const executorSteps = [
            'setup.thisComputer.ensureCli',
            'setup.thisComputer.inspectService',
            'setup.thisComputer.serviceConsent',
            'setup.thisComputer.configureRelay',
            'setup.thisComputer.checkAuth',
            'setup.thisComputer.auth.request',
            'setup.thisComputer.auth.wait',
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.restartService',
            'setup.thisComputer.pathExposure',
        ];

        for (const stepId of executorSteps) {
            expect(resolveSystemTaskStepLabel(stepId)).not.toBe(stepId);
        }
    });
});
