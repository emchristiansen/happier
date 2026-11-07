ALTER TABLE `SessionAttentionStanding` ADD COLUMN `remindAt` DATETIME(3) NULL;
ALTER TABLE `SessionAttentionStanding` ADD COLUMN `standingBeforeReminder` BOOLEAN NULL;

CREATE INDEX `SessionAttentionStanding_accountId_remindAt_idx` ON `SessionAttentionStanding`(`accountId`, `remindAt`);
