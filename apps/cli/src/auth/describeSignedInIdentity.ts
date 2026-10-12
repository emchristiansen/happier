/**
 * The words a person uses to compare this computer's sign-in with the app (plan R17): the relay by
 * host and the account by its readable label plus a short id. `auth status` and `daemon status`
 * print the same forms so the two never describe one identity differently.
 */

const SHORT_ACCOUNT_ID_LENGTH = 8;

/** The relay's host (and non-default port). Credentials and paths in the URL are never shown. */
export function formatRelayHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

function formatShortAccountId(accountId: string): string {
  return accountId.length > SHORT_ACCOUNT_ID_LENGTH + 2 ? `${accountId.slice(0, SHORT_ACCOUNT_ID_LENGTH)}…` : accountId;
}

/** `label (shortId)`, just the short id when the profile has no readable name, `null` when unknown. */
export function formatAccountIdentity(params: Readonly<{
  accountLabel: string | null;
  accountId: string | null;
}>): string | null {
  const shortId = params.accountId ? formatShortAccountId(params.accountId) : null;
  if (params.accountLabel && shortId) return `${params.accountLabel} (${shortId})`;
  return params.accountLabel ?? shortId;
}
