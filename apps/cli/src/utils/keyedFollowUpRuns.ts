import { AsyncResource } from 'node:async_hooks';

/**
 * Keyed async runs that coalesce concurrent requests into at most one queued follow-up per key.
 *
 * Per key the state is either idle (no entry) or `{ active, followUp }`:
 * - idle: a request starts a run at once; that run becomes `active`.
 * - active, request without `requireStartAfterRequest`: joins `active`.
 * - active, request with `requireStartAfterRequest`: joins the key's single queued `followUp`,
 *   creating it if absent. The follow-up starts only after `active` settles (fulfilled or rejected),
 *   so it starts after every request that joined it, and it receives every joined input.
 *   It runs in the async context of the request that created that follow-up, preserving that
 *   caller's nesting without borrowing capabilities from the caller of the preceding run.
 *
 * However many requests arrive while a run is active, at most one more run is queued for that key.
 */
export type KeyedFollowUpRunKind = 'initial' | 'follow_up';

export type KeyedFollowUpRunContext<K, I> = Readonly<{
  key: K;
  /** Inputs of every request this run serves, in arrival order. */
  inputs: readonly I[];
  kind: KeyedFollowUpRunKind;
  /**
   * True when a request served by this run asked for `requireStartAfterRequest` (always true for a
   * follow-up). The run started after every request it serves either way.
   */
  servesStartAfterRequest: boolean;
}>;

export type KeyedFollowUpRunRequestOptions = Readonly<{
  /**
   * The caller needs the outcome of a run that started after this request. A run that is already
   * active started earlier, so the request waits for the queued follow-up instead of joining it.
   */
  requireStartAfterRequest: boolean;
}>;

export type KeyedFollowUpRuns<K, I, T> = Readonly<{
  request(key: K, input: I, options: KeyedFollowUpRunRequestOptions): Promise<T>;
}>;

type QueuedFollowUp<I, T> = {
  readonly inputs: I[];
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly start: () => Promise<T>;
};

type ActiveKeyState<I, T> = {
  readonly active: Promise<T>;
  followUp: QueuedFollowUp<I, T> | null;
};

function createQueuedFollowUp<I, T>(input: I, run: (inputs: readonly I[]) => Promise<T>): QueuedFollowUp<I, T> {
  const inputs = [input];
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  // Callers observe the rejection through `promise`; this only keeps an unobserved follow-up
  // rejection from surfacing as an unhandled rejection.
  promise.catch(() => {});
  // Promotion belongs to the previous run's settlement handler. Capture this requester now so
  // starting its cohort there cannot inherit the previous caller's live auth-lock ownership.
  const start = AsyncResource.bind(() => run([...inputs]));
  return { inputs, promise, resolve, start };
}

export function createKeyedFollowUpRuns<K, I, T>(params: Readonly<{
  run: (context: KeyedFollowUpRunContext<K, I>) => Promise<T>;
}>): KeyedFollowUpRuns<K, I, T> {
  const states = new Map<K, ActiveKeyState<I, T>>();

  const start = (
    key: K,
    inputs: readonly I[],
    kind: KeyedFollowUpRunKind,
    servesStartAfterRequest: boolean,
  ): Promise<T> => {
    const active = Promise.resolve().then(async () => await params.run({
      key,
      inputs,
      kind,
      servesStartAfterRequest,
    }));
    const state: ActiveKeyState<I, T> = { active, followUp: null };
    states.set(key, state);
    const promoteFollowUp = (): void => {
      if (states.get(key) !== state) return;
      const followUp = state.followUp;
      if (!followUp) {
        states.delete(key);
        return;
      }
      followUp.resolve(followUp.start());
    };
    active.then(promoteFollowUp, promoteFollowUp);
    return active;
  };

  return Object.freeze({
    request(key: K, input: I, options: KeyedFollowUpRunRequestOptions): Promise<T> {
      const state = states.get(key);
      if (!state) return start(key, [input], 'initial', options.requireStartAfterRequest);
      if (!options.requireStartAfterRequest) return state.active;
      if (state.followUp) {
        state.followUp.inputs.push(input);
        return state.followUp.promise;
      }
      const followUp = createQueuedFollowUp<I, T>(input, (inputs) => start(key, inputs, 'follow_up', true));
      state.followUp = followUp;
      return followUp.promise;
    },
  });
}
