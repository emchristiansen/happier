import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { describe, expect, it, vi } from 'vitest';

import { resolveToolStatusIndicatorKind } from './resolveToolStatusIndicatorKind';

function createCompletedTool(result: unknown): ToolCall {
    return {
        name: 'Bash',
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result,
    };
}

describe('resolveToolStatusIndicatorKind', () => {
    it('parses an unchanged structured result once and recomputes after the result root changes', () => {
        const tool = createCompletedTool({
            content: [{
                type: 'text',
                text: '{"v":1,"ok":true,"kind":"tools_call","data":{"results":[{"ok":true}]}}',
            }],
        });
        const parseSpy = vi.spyOn(JSON, 'parse');

        expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        expect(parseSpy).toHaveBeenCalledTimes(1);

        tool.result = {
            content: [{
                type: 'text',
                text: '{"v":1,"ok":false,"kind":"tools_call","error":{"message":"failed"}}',
            }],
        };

        expect(resolveToolStatusIndicatorKind(tool)).toBe('error');
        expect(parseSpy).toHaveBeenCalledTimes(2);

        parseSpy.mockRestore();
    });
});
