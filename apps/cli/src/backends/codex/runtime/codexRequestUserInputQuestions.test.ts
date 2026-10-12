import { describe, expect, it } from 'vitest';

import {
    buildCodexAsyncUserInputReply,
    buildCodexRequestUserInputAnswers,
    normalizeCodexAsyncUserInputQuestionsToAskUserQuestionInput,
} from './codexRequestUserInputQuestions';

describe('buildCodexRequestUserInputAnswers', () => {
    it.each(['__proto__', 'constructor', 'prototype'])('round-trips reserved question id %s as an own wire key', (id) => {
        const answersByKey = Object.create(null) as Record<string, readonly string[]>;
        answersByKey['Which value?'] = ['Exact'];
        const result = buildCodexRequestUserInputAnswers({
            questions: [{ id, question: 'Which value?' }],
            answersByKey,
        });

        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(result, id)).toBe(true);
        expect(result[id]).toEqual({ answers: ['Exact'] });
        expect(JSON.parse(JSON.stringify(result))).toEqual({ [id]: { answers: ['Exact'] } });
    });
});

describe('Codex async user-input questions', () => {
    it('maps every Codex question into the shared multi-question AskUserQuestion model', () => {
        expect(normalizeCodexAsyncUserInputQuestionsToAskUserQuestionInput({
            itemId: 'message-1',
            questions: [
                { title: 'Choose an environment', options: ['Staging', 'Production'] },
                { title: 'Add release context' },
            ],
        })).toEqual({
            codexAsyncQuestionV1: {
                v: 1,
                itemId: 'message-1',
                questions: [
                    { title: 'Choose an environment', options: ['Staging', 'Production'] },
                    { title: 'Add release context' },
                ],
            },
            questions: [
                {
                    id: '["happier-codex-async-question","message-1",0]',
                    header: 'Question 1',
                    question: 'Choose an environment',
                    options: [
                        { label: 'Staging', description: '' },
                        { label: 'Production', description: '' },
                    ],
                    multiSelect: false,
                    freeform: {},
                },
                {
                    id: '["happier-codex-async-question","message-1",1]',
                    header: 'Question 2',
                    question: 'Add release context',
                    options: [],
                    multiSelect: false,
                    freeform: {},
                },
            ],
        });
    });

    it('builds one Codex reply containing every answered question', () => {
        const answersByKey = Object.create(null) as Record<string, readonly string[]>;
        answersByKey['["happier-codex-async-question","message-1",0]'] = ['Production'];
        answersByKey['["happier-codex-async-question","message-1",1]'] = ['Ship after tests'];

        const reply = buildCodexAsyncUserInputReply({
            itemId: 'message-1',
            questions: [
                { title: 'Choose\nan environment', options: ['Staging', 'Production'] },
                { title: 'Add release context' },
            ],
            answersByKey,
        });
        expect(reply?.displayText).toBe('> Choose an environment\n\nProduction\n\n> Add release context\n\nShip after tests');
        expect(reply?.text).toBe(
            '<send_user_message_question_reply>\n'
            + JSON.stringify([
                { answer: 'Production', question: 'Choose an environment', questionItemId: '["request_user_input_async","message-1",0]' },
                { answer: 'Ship after tests', question: 'Add release context', questionItemId: '["request_user_input_async","message-1",1]' },
            ])
            + '\n</send_user_message_question_reply>',
        );
    });

    it('rejects an oversized Codex form so the caller can preserve its assistant-text fallback', () => {
        expect(normalizeCodexAsyncUserInputQuestionsToAskUserQuestionInput({
            itemId: 'message-oversized',
            questions: Array.from({ length: 17 }, (_, index) => ({ title: `Question ${index + 1}` })),
        })).toEqual({ questions: [] });

        const boundedOptions = normalizeCodexAsyncUserInputQuestionsToAskUserQuestionInput({
            itemId: 'message-too-many-options',
            questions: [{
                title: 'Choose one',
                options: Array.from({ length: 129 }, (_, index) => `Option ${index + 1}`),
            }],
        }).questions[0]?.options;
        expect(boundedOptions).toHaveLength(32);
        expect(boundedOptions?.[0]?.label).toBe('Option 1');
        expect(boundedOptions?.[31]?.label).toBe('Option 32');
    });
});
