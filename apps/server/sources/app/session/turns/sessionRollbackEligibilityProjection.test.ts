import { describe, expect, it } from "vitest";

import {
    createSessionRollbackEligibleTurnsSelect,
    readSessionTurnRollbackEligibleStarts,
} from "./sessionRollbackEligibilityProjection";

describe("session rollback eligibility projection", () => {
    it("selects a bounded newest-first set of eligible turn anchors", () => {
        expect(createSessionRollbackEligibleTurnsSelect()).toEqual({
            where: { rollbackState: "eligible" },
            orderBy: [
                { updatedAt: "desc" },
                { createdAt: "desc" },
                { id: "desc" },
            ],
            take: 50,
            select: {
                transcriptAnchorsJson: true,
                rollbackState: true,
            },
        });
    });

    it("returns sorted unique trusted start sequence facts", () => {
        expect(readSessionTurnRollbackEligibleStarts({
            turns: [
                { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 9 }) },
                { rollbackState: "rolled_back", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 7 }) },
                { rollbackState: "eligible", transcriptAnchorsJson: "not-json" },
                { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 3 }) },
                { rollbackState: "eligible", transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 9 }) },
            ],
        })).toEqual([3, 9]);
    });
});
