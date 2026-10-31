import { describe, expect, it } from 'vitest';

import { getBuiltInGenericAcpAgentIds } from './builtInGenericAcpAgentIds';

describe('getBuiltInGenericAcpAgentIds', () => {
    it('derives the generic ACP settings list without first-class or user-defined providers', () => {
        const agentIds = getBuiltInGenericAcpAgentIds();

        expect(agentIds).toContain('kiro');
        expect(agentIds).not.toContain('grok');
        expect(agentIds).not.toContain('customAcp');
    });
});
