# Pending delivery architecture

## Exact Codex steering (development)

An explicit pending-input action can steer the selected `localId` into the
currently active Codex app-server turn. The runner captures that native turn
before admitting the action and sends it as `expectedTurnId` at provider dispatch.
If that turn ends, the input is refused before effect rather than redirected into
a later turn. The action uses the existing Pending custody and delivery owners.

The server advertises this operation separately as
`capabilities.session.pendingInputExactLocalId: { protocolVersion: 1 }`.
The strict `pendingInput` object keeps its existing shape, so older readers can
ignore the optional sibling. A client requires both Pending-input support and
the exact-local-ID capability. The exact materialization event selects only the
requested eligible `steer_now_bound` row; an unavailable target never substitutes another
urgent input. Ordinary materialization may defer on an unresolved delivery claim;
exact selection of an eligible input can bypass an unrelated held input, while
custody of the selected input still prevents duplicate dispatch. Publisher authority,
the original runtime/turn binding and existing fail-closed checks still apply;
selection does not prove provider acceptance.

The control observes provider outcomes before sending the admission PATCH because
a Pending wake can deliver the input before that HTTP acknowledgement returns.
A durable admission acknowledgement alone does not prove provider delivery.
`admitted_and_steered` requires observed acceptance on the captured turn;
`admitted_delivery_unobserved` means admission is known but delivery was not
observed. A lost or uncertain admission response retains the captured binding
without claiming admission or replaying the provider input. Known rejection before
effect remains distinct from that uncertainty. Session replacement and cleanup
retain the existing publisher, generation and lifetime checks.

## Accepted settlement retry (development)

Once a provider accepts a Pending input, the session client retains that exact
accepted `localId` until settlement or exact committed replay proves delivery.
Lost responses, unavailable or malformed acknowledgements, and an `internal`
settlement failure leave the outcome uncertain. The existing settlement loop
retries that same identity with capped exponential backoff while its socket,
connection epoch, producer and session lifetime remain current. It never submits
the provider input again. An explicit definitive refusal ends that operation's
retries while preserving its unresolved custody.

The local pre-emit `socket_not_connected` failure also permits that same settlement
retry only when the error explicitly carries `retryable: true`. An unqualified
failure does not gain retry permission. The existing authority checks still stop
the originating operation if its connection or runtime is no longer current.

Successful settlement or exact committed replay releases that accepted input's
retained local state. Acceptance already permits later inputs to materialize;
settlement is not a global queue gate. Canonical custody of the same input still
protects against duplicate dispatch.
Continued transport failure cannot promise queue progress. Disconnect, producer
replacement and shutdown stop the originating operation; reconnect retains the
existing exact-intent reconciliation path.

Ordinary info-level file entries identify exact acceptance observation, absent
canonical custody, unavailable settlement authority and admission to the existing
settlement owner, with the original session/input identity and generation/epoch.
Admission records an owner handoff, not proof that a request reached the server.
The existing unresolved-settlement warning includes the recognized socket,
ambiguous-transport or server-acknowledgement failure and the chosen retry
disposition; an unrecognized failure remains explicitly unknown. These entries
do not include arbitrary error messages, stacks or payload values. A missing
entry does not prove that acceptance or settlement never happened.

## Live runner wake-up recovery (development)

The session client owns pending-input wake subscriptions. A transient socket
disconnect does not end those subscriptions: idle and active-turn consumers must
still observe later eligibility updates. Caller cancellation and client close
release the client's listeners. The runtime separately aborts its consumer when
the turn or session ends.

Idle and active consumers share the same wake handling. The existing backoff for
unavailable adapters does not periodically materialize the queue. Reconnect does
not bypass settings convergence, admission, or the Pending row's blocked state;
an explicitly blocked message still requires its existing Retry action.

If the session socket stays connected after a transient server-feature probe
failure, a later pending materialization attempt reuses the session client's
connection-readiness convergence. It re-probes that same connection and, for
the current Runtime Activity contract, waits for the publisher's snapshot
settlement before claiming input.
Authentication failures and unsupported contracts still fail closed; this
recovery adds no polling or reconnect side effects.

Development source also retries transient materialization failures through the
existing idle consumer or active-turn pump. Each episode permits at most 12 failed
attempts within an absolute 30-minute window. Exponential backoff adds positive
jitter and caps the resulting local delay at 300 seconds. Eligible server retry
guidance remains a lower bound, even across a new event; guidance that cannot fit
within the remaining window exhausts the episode instead of causing an early
request. The episode's own timer never renews its budget.

Account-settings convergence uses the same budget at its existing request-only
owner. A transient failure can retry on the same connection without another hint.
The failed or applying settings barrier remains conservative, and only a current
source may commit settings. Concurrent waiters share convergence; cancelling one
waiter does not cancel the others. A still-owned request whose source becomes
stale before completion leaves a failed barrier and observes backoff, while an
older completion cannot alter a newer barrier. Request-only callers recheck the
highest observed minimum before resolving and rejoin the same owner if needed.

Exhaustion retains a typed disposition and writes one
`[pendingInput] retry episode exhausted` entry to the default-enabled session file
log, identifying the operation, reason, failed attempts, and episode timing. The
consumer then waits for an existing eligibility event or reconnect to start a
fresh episode. Cancellation stops future retries; it does not retire accepted
provider custody or authorize a new message identity. An exhausted episode is not
renewed by elapsed time alone.

### Authoritative discovery after a missed hint

A live session client's canonical provider binding owns one low-frequency timer.
The timer reads the existing authoritative session snapshot even if the cached
pending projection says empty or positive. It uses the same reconciliation and
snapshot single flights as hints and turn-end work; a joining request dirties the
current pass without starting another read. New authoritative queue state wakes
the existing consumer, which still owns materialization and provider admission.
Turn-end reconciliation also requests an authoritative snapshot. Websocket hints
and turn ends remain the fast path.

An idle healthy binding waits an independently sampled 240–360 seconds after
each completed pass. A successful read taking at least two seconds stretches the
base delay to the greater of twice the previous base and five minutes per rounded-up
second of elapsed read time, capped at thirty minutes. Failures double the base
with the same cap. Reads under one second restore the five-minute base; intermediate
read times retain it. Sampling remains 80–120% of that base, capped at thirty
minutes, and a server Retry-After remains an independent lower bound even when it
exceeds that cap. There is no immediate periodic retry burst. The maximum added
periodic read rate is one read per 240 seconds per eligible binding: 1.667 reads
per second for 400 continuously eligible bindings. At the stretched cap it is
at most one per 1,440 seconds, or 0.278 reads per second for 400 bindings. These
are source bounds, not measurements of the participating population or relay cost.
Periodic discovery never initiates the compatibility reader's paginated session-list
fallback. An older relay without the detail route therefore has no periodic recovery
guarantee; existing non-periodic compatibility callers retain their fallback.

Ticks defer during a locally active provider turn: turn-end reconciliation already
handles that boundary. They also defer while readiness or settings application is
unsettled, or the client holds reserved/accepted provider custody. Close,
termination, changed producer generation, socket/connection epoch, machine identity,
lost publisher binding and an authoritative archive observation fence late results
and disable originating timers. This adds no archive cleanup or replacement owner.

A failed authoritative discovery read followed by a readable pending snapshot at
the same authority permits one existing consumer recovery wake. New queue state
can supply its ordinary eligibility wake. Repeated unchanged readable snapshots
cannot keep renewing exhausted consumer budgets. Existing retry/server lower bounds,
settings convergence, archive admission, runtime readiness and exact provider
acceptance/settlement remain in force. A missing server row does not retire local
reserved or accepted custody; an accepted input is never delivered to the provider
again merely because its settlement acknowledgement was lost.
External deletion or manual handling without an exact completion receipt leaves
that reservation or accepted operation unresolved and blocks a later claim. The
existing exact settlement/committed-proof path must release it.

A missed hint can add up to six minutes while healthy, or thirty minutes under
stretched cadence, plus read completion and any larger server lower bound. Active
turns and unsettled prerequisites can defer discovery longer. A permanently hung
read, readiness/settings operation, reservation or provider acceptance remains
owned and unresolved; discovery does not time it out into permission or launch a
parallel operation. This development source does not update already loaded runners.

In current development source, an admitted prompt does not wait for the daemon's
`prompt_or_steer` lifecycle response. That notification informs recovery and
switching; it is not input authorization. A delayed or failed notification does
not block the Pending row. Exact turn-marker and terminal notifications retain
their existing serialized lifecycle handling.

## Current Queue V2 activation ownership

Pending Queue V2 remains the sole durable owner of message custody, ordering, and exact-row actions. An inactive-session start request is a small session-level authorization for one exact eligible queued row; it is not another message-delivery state machine and does not change that row's delivery priority.

- The server transaction that mutates Pending rows is the only writer of the current activation authorization. Pending Input V2 accepts `resumeWhenAvailable` as a mutation command, applies it atomically to the existing Session authorization, and never persists it as a second row-level desired state.
- `Session.lastActiveAt` is the lifecycle fence. An authorization at or before that value is stale and is not projected. Publisher activity therefore invalidates an old start request without a second client-owned timestamp.
- The Pending activation hint is lossy notification only. The authorization persisted on `Session` is authoritative.
- The daemon on the session's exact owning machine is the only unattended starter. It consumes live hints and one finite reconnect scan through the same activator, re-reads the session and exact Pending row, and then uses the existing inactive-session resume path.
- Machine unreachability leaves the request in `waiting`. A genuine terminal inability to start records `failed`; it is not retried merely because a daemon reconnects. Explicit retry re-arms the same exact Session authorization without changing the row's delivery action.
- Current clients delegate unattended starts only when the server advertises Pending Input V2 and the exact target machine advertises daemon activation support. Otherwise they retain the released direct-resume compatibility path.
- The account preference has one three-state owner. All ordinary inactive/offline input persists as FIFO `enqueue`. `when_available` additionally arms the exact Session authorization; `online_only` makes at most one user-present UI resume attempt when the exact machine is currently reachable; `manual` only persists the row. The default is `online_only`.
- Neither `when_available` nor `online_only` changes an ordinary row to `send_now`; that action remains reserved for an explicit immediate-delivery request. If reachability changes or an `online_only` attempt fails, Pending custody remains without authorization for a later unattended start.
- The banner actions **Process when online** and **Retry** re-arm the exact Session authorization. **Keep queued** clears that authorization and preserves FIFO delivery. These actions do not change the account preference or create a second activation path.

This design intentionally has no polling loop, lease, generation, retry counter, or client-side activation clock. Pending owns the payload; the server owns activation intent; session activity fences staleness; and the daemon owns process start.

> **Superseded attempt-design record (2026-07-14).** Queue V2 is the only active pending-delivery system. `attempt_v1` will not be activated: its runtime/protocol branches are removed after the live exact-selector contract is extracted, and its schema/migrations are squashed or forward-contracted from bounded persistence evidence. Current authority and markers: `.project/plans/pending-delivery-attempt-v1-and-session-lifecycle-reliability-unification.md`. Everything below this notice is historical design evidence, not implementation or cutover instruction.

## Historical attempt design

Pending Queue V2 remains the released durable payload and ordering owner. The following describes the abandoned admission-off attempt proposal.

## Canonical ownership

- `SessionPendingMessage` owns the exact encrypted/plain envelope, stable `localId`, role, position, and retained row disposition.
- Enqueue selects `tag_queue_v2` or `attempt_v1` once. A retry reuses the persisted selection and cannot change it.
- `packages/protocol/src/sessionMessages/pendingDeliveryAttemptV1.ts` owns only bounded attempt identity, claim selectors, the pure transition table, exact-coordinate release, and derived presentation.
- `pendingDeliveryAttemptAdmission.ts` owns the single fail-closed server admission decision. Feature advertisement, enqueue selection, and the dormant claim registrar all consume that same decision; it remains hard-disabled until the cutover gates pass.
- `pendingDeliveryAttemptEnqueueSelection.ts` translates that admission decision into the immutable protocol selected by the enqueue transaction. It is not a second gate.
- `pendingDeliveryAttemptAuthorization.ts` maps bounded human actions to the existing session access levels. Runtime claim authority remains a separate R0 concern.
- D1 will own the sole durable aggregate transaction service. Routes, sockets, workers, runtimes, providers, and UI must not write attempt or row lifecycle state directly.
- Runtime Activity remains externally owned. Pending will later consume only its typed decision and exact revision; it does not infer, time out, or write Activity truth.

## Admission boundary

There is one server-owned admission decision. It drives the advertised `sharing.pendingDeliveryAttempts` bit, immutable protocol selection at enqueue, and registration of the dormant claim transport. The decision is currently hard false; missing, malformed, or non-true advertised values therefore select the released queue contract.

The decision only makes the attempt corridor reachable; it does not authorize an individual claim. Claim authorization belongs to the D1/R0 aggregate transaction and must prove the persisted attempt contract, session active-attempt coordinate, current authenticated runtime authority, exact attempt identity, expected revision, and scoped unlogged idempotency key.

Disabling the gate must never prevent exact completion, cancellation, ambiguity resolution, or recovery of already persisted attempt work.

## Attempt kernel

One public attempt id identifies an attempt but grants no authority. The pure kernel recognizes:

`reserved → write_authorized → custody_observed → accepted`

Only exact attempt identity and expected revision can advance a state. Custody is nonterminal and never acceptance. Weaker synchronous provider submission terminates as `handoff_acknowledged`, which remains observably distinct from `accepted`.

Pre-write terminal outcomes are `retryable`, `blocked`, `cancelled`, and `dead_letter`. Post-authorization uncertainty terminates as `ambiguous`; it is never automatically retried. Owner resolution is explicit.

The session active-attempt coordinate is released only when it still equals the exact terminal attempt id. A stale terminal completion cannot clear a successor.

Head and owner-authorized exact-target dispatch share one selector contract. Exact-target dispatch identifies the stable `localId` and the deliberate `send_now | steer` override; it cannot request reorder or substitute another row.

## Derived presentation

Coarse presentation is a pure derivation from retained row disposition plus the current/latest attempt facts. No writable queued/delivering/custody/accepted twin is permitted.

- no attempt projects queued;
- reserved/write-authorized project delivering;
- custody-observed projects custody;
- terminal outcomes retain their exact names, including `handoff_acknowledged` and `ambiguous`.

The public shape may contain bounded row/attempt correlation, phase, outcome, reason, and revision. It must never contain the scoped idempotency key, provider secrets, raw evidence, content, or private runtime authority.

## Human actions

Viewers may inspect derived state. Editors may enqueue, edit/reorder/discard/restore safe pending rows, cancel before write, and request ordinary dispatch/steer/interrupt actions. Provider cancellation, hide/mark-handled, ambiguity resolution, and duplicate-risk resend are owner-only and remain distinct operations.

Human ownership never substitutes for authenticated current-runtime authority, the scoped claim idempotency key, expected-revision CAS, or exact provider evidence. UI removal is not provider cancellation and cannot delete replay fences.

## Physical compatibility fence

D1 persists attempt-retained rows with `status='attempt_queued'`. The released June materializer selects only `status='queued'`, so it cannot select those rows. Public projection maps `attempt_queued` to queued without creating a writable lifecycle shadow.

The fence, aggregate kernel, and admission-off schema exist in Remote and Dev. They remain unreachable from production enqueue because the single admission decision is hard false; cutover remains blocked until a real provider claim/evidence/mutation consumer is proven.

## Deferred work

Exact provider evidence history is deferred. A future evidence phase may add bounded, crash-safe attempt-bound receipts after provider capabilities and retention requirements are proven. D0 defines no receipt-scope registry, receipt key history, evidence capability catalog, provider declaration, or provider-specific branch.

Provider cancellation transport, consumed provider evidence adapters, owner resolution UI, cutover migration, and live ship proof remain downstream corridors. A separate runner incarnation or cryptographic claim-verifier layer must not be added unless a discriminating executable failure proves the existing authenticated channel, revision CAS, and scoped idempotency key insufficient.

## Deletion gate

Before production cutover, searches must show no active alternate owner for:

- numeric protocol floors or floor-to-contract mapping;
- per-session protocol promotion or cohort admission;
- a separate claim feature gate;
- receipt-scope/evidence-history capability scaffolding;
- provider/catalog pending-attempt capability constructors;
- direct durable transition writers outside the future aggregate;
- mutable coarse attempt presentation state;
- automatic retry after possible provider write;
- provider or Runtime Activity branching in the shared kernel.
