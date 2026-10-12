export type ServingThisComputerService<T> = Readonly<{
  serving: 'pinned' | 'default-following';
  value: T;
}>;

/** Select the installed pin for a relay first, otherwise its available default-following service.
 * Callers supply eligibility from their own status or relay-scoped installed inventory.
 */
export function resolveServingThisComputerService<T>(params: Readonly<{
  defaultFollowing: Readonly<{ eligible: boolean; value: T }>;
  pinned: readonly Readonly<{ eligible: boolean; value: T }>[];
}>): ServingThisComputerService<T> | null {
  const pinned = params.pinned.find((item) => item.eligible);
  if (pinned) return { serving: 'pinned', value: pinned.value };
  return params.defaultFollowing.eligible
    ? { serving: 'default-following', value: params.defaultFollowing.value }
    : null;
}
