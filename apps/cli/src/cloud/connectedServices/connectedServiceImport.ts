import { ConnectedServiceImportRequestV1Schema, ConnectedServiceImportSourceV1Schema, supportsConnectedServiceOperation, type ConnectedServiceImportRequestV1, type ConnectedServiceImportResponseV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { AGENTS } from '@/backends/catalog';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ConnectedServiceImportError } from './connectedServiceImportError';
import { ConnectedServiceCredentialIdentityConflictError, ConnectedServiceCredentialStorageSupersededError, ConnectedServiceCredentialStorageResultUnknownError, storeConnectedServiceCredentialForAccount, type ConnectedServiceCredentialStorageApi } from './storeConnectedServiceCredentialForAccount';

export type ConnectedServiceImportAccount = Readonly<{ api: ConnectedServiceCredentialStorageApi; credentials: Credentials }>;
type ImportFailureCode = Extract<ConnectedServiceImportResponseV1, { ok: false }>['errorCode'];
const safeMessages: Record<ImportFailureCode, string> = {
  invalid_parameters: 'Invalid import parameters.', authentication_required: 'Authenticate this machine with Happier first.',
  unsupported: 'This machine does not support native credential import for this service.', unsupported_source: 'Choose a declared native credential source.',
  credentials_unavailable: 'No supported native login is available on this machine.', reauthorization_required: 'This native login requires reauthorization. Connect in your browser.',
  provider_error: 'The provider could not validate this native login.', profile_conflict: 'This profile belongs to a different or unverified account. Choose a new profile.',
  credential_superseded: 'This profile changed during import. Refresh it before retrying.', cancelled: 'Native credential import was cancelled.',
  import_failed: 'Native credential import failed. Check the selected machine login or connect in your browser.',
  connected_service_unsupported: 'This server has not confirmed guarded credential-write support for native import. Upgrade the server or retry when it is reachable.',
  storage_result_unknown: 'The import result is unknown. Refresh the profile before retrying.',
};
function failure(errorCode: ImportFailureCode): ConnectedServiceImportResponseV1 { return { ok: false, errorCode, error: safeMessages[errorCode] }; }

/** Local acquisition is shared by CLI and machine RPC. Only its status crosses RPC. */
export async function runConnectedServiceImport(params: Readonly<{
  request: ConnectedServiceImportRequestV1; account?: ConnectedServiceImportAccount; signal?: AbortSignal;
}>): Promise<ConnectedServiceImportResponseV1> {
  const parsed = ConnectedServiceImportRequestV1Schema.safeParse(params.request);
  if (!parsed.success) return failure('invalid_parameters');
  const request = parsed.data;
  try {
    params.signal?.throwIfAborted();
    if (!params.account) return failure('authentication_required');
    const targets = await Promise.all(Object.values(AGENTS).flatMap((entry) => entry.getCloudConnectTarget ? [entry.getCloudConnectTarget()] : []));
    params.signal?.throwIfAborted();
    const target = targets.find((candidate) => candidate.importServiceId === request.serviceId);
    if (!target?.importCredentials || !target.importSources?.length) return failure('unsupported');
    const sources = target.importSources.map((source) => ConnectedServiceImportSourceV1Schema.parse(source));
    if (request.op === 'discover') return { ok: true, op: 'discover', sources };
    if (!sources.some((source) => source.id === request.source)) return failure('unsupported_source');
    const snapshot = await observeServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl(), token: params.account.credentials.token, signal: params.signal });
    params.signal?.throwIfAborted();
    if (snapshot.status !== 'ready' || snapshot.features.capabilities.connectedServices.credentialWrite.revisionGuard !== true
      || !supportsConnectedServiceOperation(snapshot.features, request.serviceId)) return failure('connected_service_unsupported');
    const payload = await target.importCredentials({ source: request.source, signal: params.signal });
    params.signal?.throwIfAborted();
    const record = buildConnectedAccountOauthCredentialRecord({ now: Date.now(), serviceId: request.serviceId, profileId: request.profileId, payload });
    await storeConnectedServiceCredentialForAccount({ ...params.account, record, identityPolicy: 'same_account_or_empty', signal: params.signal });
    return { ok: true, op: 'import', serviceId: request.serviceId, profileId: request.profileId };
  } catch (error) {
    if (error instanceof ConnectedServiceCredentialStorageResultUnknownError) return failure('storage_result_unknown');
    if (error instanceof ConnectedServiceCredentialStorageSupersededError) return failure('credential_superseded');
    if (error instanceof ConnectedServiceCredentialIdentityConflictError) return failure('profile_conflict');
    if (params.signal?.aborted) return failure('cancelled');
    if (error instanceof ConnectedServiceImportError) return failure(error.code);
    return failure('import_failed');
  }
}
