-- AlterTable
ALTER TABLE "ConnectedServiceAuthGroup" ADD COLUMN "reservationRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ConnectedServiceAssignmentReservation" (
    "id" TEXT NOT NULL,
    "groupDbId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ownerMachineId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAtMs" BIGINT NOT NULL,
    "leaseUntilMs" BIGINT NOT NULL,

    CONSTRAINT "ConnectedServiceAssignmentReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "csar_group_decision_key" ON "ConnectedServiceAssignmentReservation"("groupDbId", "decisionId");

-- AddForeignKey
ALTER TABLE "ConnectedServiceAssignmentReservation" ADD CONSTRAINT "ConnectedServiceAssignmentReservation_groupDbId_fkey" FOREIGN KEY ("groupDbId") REFERENCES "ConnectedServiceAuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
