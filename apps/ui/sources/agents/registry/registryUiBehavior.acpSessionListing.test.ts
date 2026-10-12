import { describe, expect, it } from 'vitest';

import { AGENTS_UI_BEHAVIOR } from './registryUiBehavior';

describe('ACP session-listing UI behavior', () => {
    it.each(['auggie', 'qwen', 'kilo', 'devin', 'kimi', 'copilot', 'fx'] as const)(
        'offers resume-only ACP sessions for %s',
        (agentId) => {
            const getSourceOptions = AGENTS_UI_BEHAVIOR[agentId].directSessions?.browse?.getSourceOptions;
            expect(getSourceOptions).toBeTypeOf('function');
            const options = getSourceOptions?.({
                agentId,
                profile: null,
                directory: '/workspace/project',
                settings: {} as never,
            });

            expect(AGENTS_UI_BEHAVIOR[agentId].directSessions?.browse?.resumeOnly).toBe(true);
            expect(options).toEqual([{
                key: 'acp:sessionList',
                label: expect.any(String),
                source: { kind: 'acpSessionList', cwd: '/workspace/project' },
            }]);
        },
    );
});
