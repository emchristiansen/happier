import { looksLikeFreeformQuestionHintLabel } from '@/agent/questions/structuredQuestionAnswerText';
import {
    STRUCTURED_QUESTION_LIMITS,
    StructuredQuestionAnswersV1Schema,
    normalizeStructuredQuestionDescriptors,
} from '@happier-dev/protocol';

type RecordLike = Record<string, unknown>;

type AskUserQuestionOption = Readonly<{
    label: string;
    description: string;
}>;

type AskUserQuestionEntry = Readonly<{
    id?: string;
    header: string;
    question: string;
    options: ReadonlyArray<AskUserQuestionOption>;
    multiSelect: boolean;
    freeform?: Readonly<{
        placeholder?: string;
        description?: string;
    }>;
}>;

type CodexAsyncUserInputQuestion = Readonly<{
    index: number;
    title: string;
    responseKey: string;
    options: readonly string[];
    questionItemId: string;
}>;

const CODEX_ASYNC_MAX_SUGGESTED_OPTIONS = 32;
const CODEX_ASYNC_MAX_OPTION_UTF8_BYTES = 512;
const CODEX_ASYNC_QUESTION_MARKER_KEY = 'codexAsyncQuestionV1';
const CODEX_ASYNC_QUESTION_DELIVERY_KEY = 'codexAsyncQuestionDeliveryV1';

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function buildCodexAsyncQuestionItemId(itemId: string, index: number): string {
    // Codex questions have no provider question id. This identifier is Happier-local and exists
    // only to correlate duplicate question titles in the shared structured-answer UI.
    return JSON.stringify(['happier-codex-async-question', itemId, index]);
}

function normalizeCodexAsyncQuestions(params: Readonly<{
    itemId: string;
    questions: unknown;
}>): CodexAsyncUserInputQuestion[] {
    if (
        !Array.isArray(params.questions)
        || params.questions.length > STRUCTURED_QUESTION_LIMITS.maxQuestions
    ) return [];
    const output: CodexAsyncUserInputQuestion[] = [];
    const titleOccurrences = new Map<string, number>();
    for (const [index, rawQuestion] of params.questions.entries()) {
        const question = asRecord(rawQuestion);
        const title = normalizeString(question?.title);
        if (!title) continue;
        const options = Array.isArray(question?.options)
            ? question.options
                .slice(0, CODEX_ASYNC_MAX_SUGGESTED_OPTIONS)
                .map((option) => normalizeString(option))
                .filter((option) => (
                    option.length > 0
                    && Buffer.byteLength(option, 'utf8') <= CODEX_ASYNC_MAX_OPTION_UTF8_BYTES
                ))
            : [];
        const occurrence = (titleOccurrences.get(title) ?? 0) + 1;
        titleOccurrences.set(title, occurrence);
        output.push({
            index,
            title,
            responseKey: occurrence === 1 ? title : `${title} (${occurrence})`,
            options,
            questionItemId: buildCodexAsyncQuestionItemId(params.itemId, index),
        });
    }
    return output;
}

export function normalizeCodexAsyncUserInputQuestionsToAskUserQuestionInput(params: Readonly<{
    itemId: string;
    questions: unknown;
}>): Readonly<{ questions: ReadonlyArray<AskUserQuestionEntry> }> {
    const questions = normalizeCodexAsyncQuestions(params);
    const input = {
        [CODEX_ASYNC_QUESTION_MARKER_KEY]: { v: 1, itemId: params.itemId, questions: params.questions },
        questions: questions.map((question, index) => ({
            id: question.questionItemId,
            header: `Question ${index + 1}`,
            question: question.responseKey,
            options: question.options.map((option) => ({ label: option, description: '' })),
            multiSelect: false,
            freeform: {},
        })),
    };
    return normalizeStructuredQuestionDescriptors(input.questions).ok
        ? input
        : { questions: [] };
}

export type CodexAsyncQuestionRequest = Readonly<{
    itemId: string;
    questions: unknown;
    input: Readonly<Record<string, unknown>>;
}>;

export function readPendingCodexAsyncQuestionRequest(value: unknown): CodexAsyncQuestionRequest | null {
    const request = asRecord(value);
    if (!request || request.tool !== 'AskUserQuestion') return null;
    const input = asRecord(request.arguments);
    const marker = asRecord(input?.[CODEX_ASYNC_QUESTION_MARKER_KEY]);
    if (marker?.v !== 1 || typeof marker.itemId !== 'string' || marker.itemId.trim().length === 0) return null;
    if (!Array.isArray(marker.questions) || !input) return null;
    return {
        itemId: marker.itemId,
        questions: marker.questions,
        input,
    };
}

export type CodexAsyncQuestionDelivery = Readonly<{
    itemId: string;
    questions: unknown;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>;

export function readPendingCodexAsyncQuestionDelivery(value: unknown): CodexAsyncQuestionDelivery | null {
    const completed = asRecord(value);
    if (!completed || completed.tool !== 'AskUserQuestion') return null;
    const input = asRecord(completed.arguments);
    const marker = asRecord(input?.[CODEX_ASYNC_QUESTION_MARKER_KEY]);
    if (marker?.v !== 1 || typeof marker.itemId !== 'string' || marker.itemId.trim().length === 0) return null;
    const delivery = asRecord(completed[CODEX_ASYNC_QUESTION_DELIVERY_KEY]);
    if (delivery?.status === 'delivered') return null;
    const answers = StructuredQuestionAnswersV1Schema.safeParse(completed.structuredAnswersV1);
    if (!answers.success || !Array.isArray(marker.questions)) return null;
    return {
        itemId: marker.itemId,
        questions: marker.questions,
        answersByKey: answers.data,
    };
}

export function isCodexAsyncQuestionDeliveryCompleted(value: unknown, itemId: string): boolean {
    const completed = asRecord(value);
    const input = asRecord(completed?.arguments);
    const marker = asRecord(input?.[CODEX_ASYNC_QUESTION_MARKER_KEY]);
    const delivery = asRecord(completed?.[CODEX_ASYNC_QUESTION_DELIVERY_KEY]);
    if (marker?.v !== 1 || marker.itemId !== itemId) return false;
    if (delivery?.status === 'delivered') return true;
    return completed?.status === 'canceled' && completed.decision === 'abort';
}

export function markCodexAsyncQuestionDeliveryCompleted(value: unknown, itemId: string): unknown {
    const completed = asRecord(value);
    const input = asRecord(completed?.arguments);
    const marker = asRecord(input?.[CODEX_ASYNC_QUESTION_MARKER_KEY]);
    if (!completed || marker?.v !== 1 || marker.itemId !== itemId) return value;
    return {
        ...completed,
        [CODEX_ASYNC_QUESTION_DELIVERY_KEY]: { v: 1, status: 'delivered' },
    };
}

function truncateUtf8AtCharacterBoundary(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    let output = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > maxBytes) break;
        output += character;
        bytes += characterBytes;
    }
    return output;
}

function readCodexAsyncAnswer(
    question: CodexAsyncUserInputQuestion,
    answersByKey: Readonly<Record<string, readonly string[]>>,
): string | null {
    const candidates = [
        answersByKey[question.questionItemId],
        answersByKey[question.responseKey],
        answersByKey[question.title],
    ];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue;
        const answer = candidate.map((entry) => normalizeString(entry)).find(Boolean);
        if (answer) return answer;
    }
    return null;
}

export function buildCodexAsyncUserInputReply(params: Readonly<{
    itemId: string;
    questions: unknown;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>): Readonly<{ text: string; displayText: string }> | null {
    const replies: Array<{ answer: string; question: string; questionItemId: string }> = [];
    const fallbackReplies: string[] = [];
    const displayBlocks: string[] = [];
    for (const question of normalizeCodexAsyncQuestions(params)) {
        const answer = readCodexAsyncAnswer(question, params.answersByKey);
        if (!answer) continue;
        const boundedQuestion = truncateUtf8AtCharacterBoundary(question.title, 512).replace(/[\n\r]/g, ' ');
        const questionItemId = JSON.stringify(['request_user_input_async', params.itemId, question.index]);
        if (Buffer.byteLength(questionItemId, 'utf8') > 512) {
            fallbackReplies.push(`> ${boundedQuestion}\n\n${answer}`);
        } else {
            replies.push({ answer, question: boundedQuestion, questionItemId });
        }
        displayBlocks.push(`> ${boundedQuestion}\n\n${answer}`);
    }
    if (replies.length === 0 && fallbackReplies.length === 0) return null;
    return {
        text: [
            ...(replies.length > 0
                ? [`<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`]
                : []),
            ...fallbackReplies,
        ].join('\n\n'),
        displayText: displayBlocks.join('\n\n'),
    };
}

function readQuestionOptions(question: RecordLike): ReadonlyArray<RecordLike> {
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    return rawOptions
        .map((option) => asRecord(option))
        .filter((option): option is RecordLike => Boolean(option));
}

function readApprovalLabels(questions: unknown): string[] {
    if (!Array.isArray(questions)) return [];
    return questions
        .map((question) => asRecord(question))
        .filter((question): question is RecordLike => Boolean(question))
        .flatMap((question) => readQuestionOptions(question))
        .map((option) => normalizeString(option.label))
        .filter((label) => label.length > 0);
}

export function looksLikeCodexApprovalRequestUserInput(params: Readonly<{
    toolName: string;
    questions: unknown;
}>): boolean {
    const normalizedToolName = params.toolName.trim().toLowerCase();
    if (normalizedToolName.includes('request_user_input') || normalizedToolName.includes('askuserquestion')) {
        return false;
    }

    if (!Array.isArray(params.questions) || params.questions.length === 0) return false;
    if (params.questions.some((question) => normalizeString(asRecord(question)?.id).startsWith('mcp_tool_call_approval_'))) {
        return true;
    }

    const labels = readApprovalLabels(params.questions);
    const hasApproval = labels.some((label) => /\bapprove\b|\ballow\b|\baccept\b/i.test(label));
    const hasDeny = labels.some((label) => /\bdeny\b|\breject\b|\bdecline\b/i.test(label));
    return hasApproval && hasDeny;
}

function normalizeAskUserQuestionEntry(question: unknown): AskUserQuestionEntry | null {
    const record = asRecord(question);
    if (!record) return null;

    const header = normalizeString(record.header);
    const prompt = normalizeString(record.question);
    if (!header && !prompt) return null;

    const multiSelect = record.multiSelect === true || record.multiple === true;
    const parsedOptions = readQuestionOptions(record)
        .map((option) => ({
            label: normalizeString(option.label),
            description: normalizeString(option.description),
            isOther: option.isOther === true,
        }))
        .filter((option) => option.label.length > 0);

    const explicitOptions = parsedOptions
        .filter((option) => !option.isOther)
        .map((option) => ({
            label: option.label,
            description: option.description,
        }));

    const otherOption = parsedOptions.find((option) => option.isOther)
        ?? parsedOptions.find((option) => looksLikeFreeformQuestionHintLabel(option.label))
        ?? null;

    const freeform = otherOption
        ? {
            ...(otherOption.label ? { placeholder: otherOption.label } : null),
            ...(otherOption.description ? { description: otherOption.description } : null),
        }
        : undefined;

    return {
        header,
        question: prompt || header,
        options: explicitOptions,
        multiSelect,
        ...(freeform && (!multiSelect || explicitOptions.length === 0) ? { freeform } : null),
    };
}

export function normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput(questions: unknown): Readonly<{
    questions: ReadonlyArray<AskUserQuestionEntry>;
}> {
    const normalizedQuestions = Array.isArray(questions)
        ? questions
            .map((question) => normalizeAskUserQuestionEntry(question))
            .filter((question): question is AskUserQuestionEntry => Boolean(question))
        : [];

    return { questions: normalizedQuestions };
}

function resolveAnswerValues(params: Readonly<{
    question: RecordLike;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>): readonly string[] {
    const questionId = normalizeString(params.question.id);
    const questionText = normalizeString(params.question.question);
    const header = normalizeString(params.question.header);

    if (questionId && Array.isArray(params.answersByKey[questionId])) return params.answersByKey[questionId]!;
    if (questionText && Array.isArray(params.answersByKey[questionText])) return params.answersByKey[questionText]!;
    if (header && Array.isArray(params.answersByKey[header])) return params.answersByKey[header]!;
    return [];
}

export function buildCodexRequestUserInputAnswers(params: Readonly<{
    questions: unknown;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>): Record<string, { answers: string[] }> {
    if (!Array.isArray(params.questions)) return Object.create(null) as Record<string, { answers: string[] }>;

    const answers = Object.create(null) as Record<string, { answers: string[] }>;
    for (const rawQuestion of params.questions) {
        const question = asRecord(rawQuestion);
        if (!question) continue;
        const questionId = normalizeString(question.id);
        if (!questionId) continue;

        const answerValues = resolveAnswerValues({ question, answersByKey: params.answersByKey });
        if (answerValues.length === 0) continue;
        answers[questionId] = { answers: [...answerValues] };
    }

    return answers;
}
