ALTER TABLE "SessionAttentionStanding" ADD COLUMN "remindAt" DATETIME;
ALTER TABLE "SessionAttentionStanding" ADD COLUMN "standingBeforeReminder" BOOLEAN;

CREATE INDEX "SessionAttentionStanding_accountId_remindAt_idx" ON "SessionAttentionStanding"("accountId", "remindAt");
