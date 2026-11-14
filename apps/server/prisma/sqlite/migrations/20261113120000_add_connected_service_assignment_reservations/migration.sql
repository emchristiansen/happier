-- AlterTable
-- In-place ADD COLUMN (as earlier SQLite migrations do) rather than Prisma's table rebuild, so
-- existing groups and their cascading members are never copied or dropped.
ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "reservationRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ConnectedServiceAssignmentReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupDbId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ownerMachineId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAtMs" BIGINT NOT NULL,
    "leaseUntilMs" BIGINT NOT NULL,
    CONSTRAINT "ConnectedServiceAssignmentReservation_groupDbId_fkey" FOREIGN KEY ("groupDbId") REFERENCES "ConnectedServiceAuthGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "csar_group_decision_key" ON "ConnectedServiceAssignmentReservation"("groupDbId", "decisionId");
