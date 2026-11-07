import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type ActiveServerStoredTokenValidationResult = Readonly<
  /**
   * `accountLabel` is how the profile names the account for people (username, else display name),
   * so `auth status`/`daemon status` and the app can say WHICH account this computer is signed in
   * as. `null` when the profile carries neither; readers fall back to a short account id.
   */
  | { state: 'valid'; httpStatus: number; accountId: string; accountLabel: string | null }
  | { state: 'invalid'; httpStatus: number; reasonCode: string }
  | { state: 'unknown'; httpStatus: number | null; reasonCode: string }
>;

function readResponseCode(body: unknown, fallback: string): string {
  return typeof (body as { code?: unknown })?.code === 'string' && (body as { code: string }).code.trim()
    ? (body as { code: string }).code.trim()
    : fallback;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readAccountLabel(body: unknown): string | null {
  const profile = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const username = readTrimmedString(profile.username);
  if (username) {
    return username;
  }
  const displayName = [readTrimmedString(profile.firstName), readTrimmedString(profile.lastName)]
    .filter((part): part is string => part !== null)
    .join(' ');
  return displayName || null;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function validateStoredAuthTokenAgainstServer(params: Readonly<{
  token: string;
  serverUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>): Promise<ActiveServerStoredTokenValidationResult> {
  const token = params.token;
  const trimmedToken = String(token ?? '').trim();
  if (!trimmedToken) {
    return { state: 'invalid', httpStatus: 401, reasonCode: 'missing-token' };
  }

  const baseUrl = String(params.serverUrl ?? resolveServerHttpBaseUrl()).trim().replace(/\/+$/u, '');
  if (!baseUrl) {
    return { state: 'unknown', httpStatus: null, reasonCode: 'missing-server-url' };
  }
  const fetchImpl = params.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/v1/account/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 5_000),
    });

    const body = await readJsonBody(response);
    if (response.ok) {
      const accountId = (body as { id?: unknown } | null)?.id;
      if (typeof accountId === 'string' && accountId.trim().length > 0) {
        return { state: 'valid', httpStatus: response.status, accountId: accountId.trim(), accountLabel: readAccountLabel(body) };
      }
      return { state: 'unknown', httpStatus: response.status, reasonCode: 'invalid-profile-response' };
    }

    if (isAuthenticationStatus(response.status)) {
      return {
        state: 'invalid',
        httpStatus: response.status,
        reasonCode: readResponseCode(body, 'not_authenticated'),
      };
    }

    return {
      state: 'unknown',
      httpStatus: response.status,
      reasonCode: readResponseCode(body, `http-${response.status}`),
    };
  } catch (error) {
    return {
      state: 'unknown',
      httpStatus: null,
      reasonCode: error instanceof Error ? error.name : 'request-error',
    };
  }
}

export async function validateStoredAuthTokenAgainstActiveServer(
  token: string,
): Promise<ActiveServerStoredTokenValidationResult> {
  return await validateStoredAuthTokenAgainstServer({ token });
}
