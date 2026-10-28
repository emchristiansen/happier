import { beforeEach, describe, expect, it } from "vitest";

import {
    applySessionTurnMutation,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitUpdate,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

describe("sessionRoutes session turns", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("applies a session turn mutation and fans out materialized session fields", async () => {
        applySessionTurnMutation.mockResolvedValue({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            rollbackEligibleTurnStarts: [3, 7],
            participantCursors: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/turns/mutations");
        expect(route.routeExists).toBe(true);
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "turn-1",
                observedAt: 123,
            },
        });

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "turn-1",
                observedAt: 123,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 10, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            rollbackEligibleTurnStarts: [3, 7],
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 11, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            rollbackEligibleTurnStarts: [3, 7],
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({
            success: true,
            applied: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
        });
    });

    it("rejects mismatched session ids before applying the mutation", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/turns/mutations");
        expect(route.routeExists).toBe(true);
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                v: 1,
                sessionId: "s2",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                observedAt: 123,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(res).toEqual({ error: "Invalid parameters" });
        expect(applySessionTurnMutation).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns the canonical non-positive exact receipt without converting it to success", async () => {
        applySessionTurnMutation.mockResolvedValue({
            ok: true,
            didApply: false,
            reason: "missing-turn",
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "exact-end-missing",
                turnId: "turn-1",
                action: "end_session",
                decision: "missing-turn",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/turns/mutations");
        const { response } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                v: 1,
                sessionId: "s1",
                mutationId: "exact-end-missing",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 123,
            },
        });

        expect(response).toEqual({
            success: true,
            applied: false,
            reason: "missing-turn",
            receipt: expect.objectContaining({ decision: "missing-turn", turnId: "turn-1" }),
        });
    });

    it("returns a session turns projection from server-readable rows", async () => {
        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/turns");
        expect(route.routeExists).toBe(true);
    });
});
