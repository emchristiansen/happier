import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { listAccountPets } from '@/sync/api/pets/apiAccountPets';
import type { AccountPetMetadata } from '@/sync/domains/pets/accountPetLibraryTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveRuntimeFeatureDecisionOrThrow } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export async function fetchAndApplyAccountPets(params: Readonly<{
    credentials: AuthCredentials | null | undefined;
    readScope: () => ServerAccountScope | null;
    applyAccountPets: (pets: AccountPetMetadata[]) => void;
    applyAccountPetsForScope: (scope: ServerAccountScope, pets: AccountPetMetadata[]) => void;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    if (!params.credentials) return;
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    const activeServer = getActiveServerSnapshot();
    const decision = await resolveRuntimeFeatureDecisionOrThrow({
        featureId: 'pets.sync',
        serverId: activeServer.serverId,
    });
    if (!shouldContinue()) return;
    if (decision.state !== 'enabled') return;

    const pets = await listAccountPets(params.credentials);
    if (!shouldContinue()) return;

    const scope = params.readScope();
    if (scope) {
        params.applyAccountPetsForScope(scope, pets);
        return;
    }
    params.applyAccountPets(pets);
}
