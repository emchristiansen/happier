-- AlterTable
ALTER TABLE `ConnectedServiceAuthGroup` ADD COLUMN `reservationRevision` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `ConnectedServiceAssignmentReservation` (
    `id` VARCHAR(191) NOT NULL,
    `groupDbId` VARCHAR(191) NOT NULL,
    `decisionId` VARCHAR(200) NOT NULL,
    `profileId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `ownerMachineId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `createdAtMs` BIGINT NOT NULL,
    `leaseUntilMs` BIGINT NOT NULL,

    UNIQUE INDEX `csar_group_decision_key`(`groupDbId`, `decisionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ConnectedServiceAssignmentReservation` ADD CONSTRAINT `ConnectedServiceAssignmentReservation_groupDbId_fkey` FOREIGN KEY (`groupDbId`) REFERENCES `ConnectedServiceAuthGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
