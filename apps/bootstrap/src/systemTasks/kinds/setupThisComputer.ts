import { systemTasks } from '@happier-dev/cli-common';
import type { FirstPartyAcquisitionOptions } from '@happier-dev/cli-common/firstPartyRuntime';
import { reportCliAcquisitionProgress } from '../cliAcquisitionProgress.js';
import {
  createServerUrlComparableKey,
  createSetupAccountConsentPromptData,
  createSetupCliChoicePromptData,
  createSetupPairingPromptData,
  createSetupServiceConsentPromptData,
  readSetupCliChoiceAnswer,
  SETUP_ACCOUNT_CONSENT_PROMPT_KIND,
  SETUP_CLI_CHOICE_PROMPT_KIND,
  SETUP_PAIRING_PROMPT_KIND,
  SETUP_SERVICE_CONSENT_PROMPT_KIND,
  setupReplacesValidatedAccount,
} from '@happier-dev/protocol';
import {
  ensureHappierCliPathExposure,
  removeHappierCliPathExposure,
  resolveFirstPartyInstallLayout,
  writeHappierCliChoice,
  type HappierCliChoice,
  type HappierCliPathRemovalResult,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { InteractiveSystemTaskContext, InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  inspectLocalHappierCliChoice,
  type LocalHappierCliChoiceInspection,
  type SetupCapableLocalHappierCli,
} from '../happierCli.js';
import {
  type AuthPairingClaim,
  type AuthPairingRequest,
  type AuthStatusSnapshot,
  type ConfiguredRelay,
  type DaemonStatusSnapshot,
  type LocalHappierCliInvocation,
  type RelayProfileTarget,
  type ServiceInstallApplyFlags,
  type SetupServiceTargetMode,
  type ServiceInstallPreview,
  createSelectedCliInvocation,
  createSetupCliScope,
  markInstallDesktopManaged,
  pinInvocationToServerProfile,
  previewServiceInstall,
  readAuthStatus,
  readDaemonStatus,
  readPinnedServiceInventory,
  relayUrlsOverlap,
} from '../localDaemonCli.js';
import type { LocalFirstPartyCommandProvenance } from '../localFirstPartyCommand.js';
import { ACCEPTED_BOOTSTRAP_CHANNELS, normalizeBootstrapChannel } from '../taskRuntime.js';

export type SetupThisComputerParams = Readonly<{
  activeRelayUrl: string;
  activeWebappUrl: string;
  activeLocalRelayUrl: string | null;
  releaseRing: PublicReleaseRingId;
  expectedAccountId: string;
  /**
   * D1 — the account the person already agreed this computer may leave (the app asked before
   * starting the run). It covers exactly that account: any other one the target relay's
   * credentials turn out to belong to is asked about here.
   */
  replaceAccountId?: string;
  /**
   * R12 — Settings › This computer › Command line's change action: ask the one-CLI question again
   * even though this computer already answered it.
   */
  reconsiderCli?: boolean;
  /** Change this home's CLI choice without converging a relay's user-owned service. */
  cliOnly?: boolean;
  /**
   * Which of this computer's services serves the app's relay (`SetupServiceTargetMode`). Absent is
   * `default-following`: the released contract, which selects the relay for this Happier home.
   * `pinned` gives the relay its own background service and never touches the persisted selection
   * or the default-following service ("connect to this relay too").
   */
  serviceTargetMode?: SetupServiceTargetMode;
  surface?: string;
}>;

export type SetupThisComputerServiceAction = 'install' | 'start' | 'restart';

/**
 * The slice of the daemon status the lifecycle decision (E3) reads before the relay changes, and —
 * for a pinned run — the default-following service's login-start mode, which the pinned service
 * is installed with (one setting governs every service the app manages).
 */
export type ServiceLifecycleObservation = Pick<DaemonStatusSnapshot, 'serviceInstalled' | 'daemonRunning' | 'serverComparableKey'>
  & Readonly<{ service?: Pick<DaemonStatusSnapshot['service'], 'autostart'> }>;

/**
 * hsetup writes this line to stdout unredacted (only events are redacted), so it carries no URL:
 * the relay the app selected is the app's own input, and a credential-bearing one would reach the
 * app's logs and the bridge's snapshots verbatim. `relayChanged` reports the outcome instead.
 *
 * PATH exposure is absent for the same reason it is not awaited (R6): the app begins its readiness
 * proof from this result, so anything reported here gates the reveal. Its state is read — and
 * repaired — through the `cli.pathExposure.*` tasks that own it.
 */
export type SetupThisComputerResult = Readonly<{
  /** A CLI-only choice does not pair or establish a machine identity. */
  machineId: string | null;
  cliProvenance: LocalFirstPartyCommandProvenance;
  cliVersion: string;
  relayChanged: boolean;
  credentialsChanged: boolean;
  /**
   * The lifecycle action the executor selected (E3). A consented replace/takeover apply may also
   * have run beside it — that is the CLI's convergence command, not a lifecycle decision.
   * `none` means this run changed only the home's CLI choice.
   */
  serviceAction: SetupThisComputerServiceAction | 'none';
}>;

type PathExposureOutcome = Readonly<{
  changed: boolean;
  shellReloadHint: string | null;
  failure: string | null;
}>;

/**
 * Every CLI command in the run takes an invocation of the CLI `ensureCli` resolved, and the
 * parameter is required here so the executor cannot forget one: the pairing this run approves is
 * bound to that exact command path and provenance (INV2), and re-resolving per command would let a
 * different binary — an override that appeared or disappeared mid-run, a freshly promoted managed
 * install — answer the commands that write credentials and install the service. The invocation
 * also carries the run's one relay context (`SetupCliScope`, R13 a), so no command inherits a
 * server selection the app was launched with.
 */
export type SetupThisComputerDeps = Readonly<{
  /** R12 — the recorded CLI choice and the one question to ask, if any. Read-only. */
  inspectCliChoice: (params: Readonly<{ reconsider: boolean }>) => Promise<LocalHappierCliChoiceInspection>;
  /** R12 — records the answer for this computer (every Happier app in this `~/.happier`). */
  recordCliChoice: (choice: HappierCliChoice) => Promise<void>;
  /** "Keep my own" — takes back only the PATH lines Desktop wrote, so the terminal runs that CLI. */
  removePathExposure: () => Promise<HappierCliPathRemovalResult>;
  ensureCli: (params: FirstPartyAcquisitionOptions & Readonly<{ releaseRing: PublicReleaseRingId }>) => Promise<SetupCapableLocalHappierCli>;
  previewServiceInstall: (
    releaseRing: PublicReleaseRingId,
    cli: LocalHappierCliInvocation,
  ) => Promise<ServiceInstallPreview>;
  configureRelay: (
    releaseRing: PublicReleaseRingId,
    profile: RelayProfileTarget,
    cli: LocalHappierCliInvocation,
  ) => Promise<ConfiguredRelay>;
  /**
   * N4/N5 — the run's own CLI's pinned-service inventory (list only): its coexistence capability and
   * the relays that already have their own service here, readable or not. Read-only.
   */
  readPinnedServiceInventory: (
    releaseRing: PublicReleaseRingId,
    cli: LocalHappierCliInvocation,
  ) => Promise<Readonly<{ listed: boolean; coexistence: boolean; relayUrls: readonly string[] }>>;
  /** F1 — the relay's saved CLI profile, added without selecting it when the CLI has none. */
  registerRelayProfile: (
    releaseRing: PublicReleaseRingId,
    profile: RelayProfileTarget,
    cli: LocalHappierCliInvocation,
  ) => Promise<Readonly<{ id: string }>>;
  readAuthStatus: (
    releaseRing: PublicReleaseRingId,
    cli: LocalHappierCliInvocation,
  ) => Promise<AuthStatusSnapshot>;
  requestAuthPairing: (
    releaseRing: PublicReleaseRingId,
    cli: LocalHappierCliInvocation,
  ) => Promise<AuthPairingRequest>;
  waitForAuthPairing: (
    releaseRing: PublicReleaseRingId,
    params: Readonly<{ publicKey: string; replaceExisting: boolean }>,
    cli: LocalHappierCliInvocation,
  ) => Promise<AuthPairingClaim>;
  readDaemonStatus: (
    releaseRing: PublicReleaseRingId,
    cli: LocalHappierCliInvocation,
  ) => Promise<ServiceLifecycleObservation>;
  installService: (
    releaseRing: PublicReleaseRingId,
    flags: ServiceInstallApplyFlags,
    cli: LocalHappierCliInvocation,
  ) => Promise<void>;
  startService: (
    releaseRing: PublicReleaseRingId,
    params: Readonly<{ action: 'start' | 'restart'; takeover: boolean }>,
    cli: LocalHappierCliInvocation,
  ) => Promise<void>;
  ensurePathExposure: (params: Readonly<{ releaseRing: PublicReleaseRingId }>) => Promise<PathExposureOutcome>;
}>;

/**
 * The deps whose real implementation changes this computer: it installs the managed CLI, rewrites
 * the CLI's relay profile and credentials, installs/starts the background service, or edits the
 * user's shell startup files. Requiring them means a caller — a test above all — cannot construct
 * the kind without deciding, so a forgotten stub is a compile error instead of a silent mutation
 * of the developer's machine.
 */
type MutatingSetupDepName =
  | 'recordCliChoice'
  | 'removePathExposure'
  | 'ensureCli'
  | 'configureRelay'
  | 'registerRelayProfile'
  | 'requestAuthPairing'
  | 'waitForAuthPairing'
  | 'installService'
  | 'startService'
  | 'ensurePathExposure';

/** Every mutating dep is explicit; the read-only reads keep their real default. */
export type SetupThisComputerDepsInput =
  Pick<SetupThisComputerDeps, MutatingSetupDepName>
  & Partial<Omit<SetupThisComputerDeps, MutatingSetupDepName>>;

const STEP = {
  cliChoice: 'setup.thisComputer.cliChoice',
  ensureCli: 'setup.thisComputer.ensureCli',
  inspectService: 'setup.thisComputer.inspectService',
  serviceConsent: 'setup.thisComputer.serviceConsent',
  accountConsent: 'setup.thisComputer.accountConsent',
  configureRelay: 'setup.thisComputer.configureRelay',
  checkAuth: 'setup.thisComputer.checkAuth',
  authRequest: 'setup.thisComputer.auth.request',
  authWait: 'setup.thisComputer.auth.wait',
  installService: 'setup.thisComputer.installService',
  startService: 'setup.thisComputer.startService',
  restartService: 'setup.thisComputer.restartService',
  pathExposure: 'setup.thisComputer.pathExposure',
} as const;

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }
}

function readApproval(answer: unknown): boolean {
  return Boolean(answer && typeof answer === 'object' && (answer as { approved?: unknown }).approved === true);
}

/**
 * The fixed refusal code the app answered a prompt with, or `null` when it named none.
 *
 * Unattended approval refuses silently by design (a wrong relay, an override CLI, an account that
 * is not the one being set up), so without the code the user sees only "not approved". Only a
 * `snake_case` token is accepted: the answer crosses the app bridge, and an error message must
 * never become a channel for arbitrary text.
 */
function readRefusalReason(answer: unknown): string | null {
  const reason = answer && typeof answer === 'object' ? (answer as { reason?: unknown }).reason : null;
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null;
}

/**
 * The one executor that makes this computer ready for the relay the app selected (R9/INV1).
 *
 * Order (plan §R12, and revision R12 "one CLI per computer" first): validate the explicit target →
 * ask the one-CLI question when this computer has a `happier` it did not install and no answer →
 * ensure a trusted, floor-compatible CLI →
 * preview the service install and obtain consent before any mutation → configure the relay →
 * validate credentials for that relay → pair (or claim with `--replace-existing` on an account
 * mismatch) → install/start/restart through the CLI service owner. Readiness is proven by the
 * ambient `runtimeConvergence` read afterwards, never by this result (INV8).
 *
 * `serviceTargetMode: pinned` is the same run for the relay's own background service: every step
 * above except configuring the relay, each addressed to that relay and its pinned service, so the
 * persisted selection and the default-following service keep serving the relay they served.
 */
export function createSetupThisComputerKind(
  overrides: SetupThisComputerDepsInput,
): InteractiveSystemTaskKind<SetupThisComputerResult> {
  const deps = createSetupThisComputerDeps(overrides);

  return {
    async run(ctx: InteractiveSystemTaskContext): Promise<SetupThisComputerResult> {
      const params = parseSetupThisComputerParams(ctx.params);
      const ring = params.releaseRing;

      // R12 — one CLI per computer, asked once and before anything is written: acquiring the
      // managed CLI is itself the second CLI the question is about.
      const inspectedChoice = await deps.inspectCliChoice({ reconsider: params.reconsiderCli === true });
      throwIfCancelled(ctx.signal);
      let cliChoice = inspectedChoice.choice;
      const question = inspectedChoice.question;
      if (question) {
        const answer = readSetupCliChoiceAnswer(await ctx.prompt({
          kind: SETUP_CLI_CHOICE_PROMPT_KIND,
          stepId: STEP.cliChoice,
          message: 'Should Happier manage the command line on this computer?',
          data: createSetupCliChoicePromptData(question),
        }));
        if (!answer) {
          throw new systemTasks.SystemTaskExecutionError(
            'cli_choice_unanswered',
            'Setup stopped before changing anything: choose whether Happier manages the command line on this computer.',
          );
        }
        throwIfCancelled(ctx.signal);
        if (answer === 'own' && question.keepBlockedBy) {
          // RV3-1: the question said keeping this CLI cannot make the terminal run it (a managed CLI
          // Happier did not expose answers first), so "own" is not an answer it offered.
          throw new systemTasks.SystemTaskExecutionError(
            'cli_choice_unanswered',
            `Setup stopped before changing anything: new terminals run the Happier CLI at ${question.keepBlockedBy} first, so keeping ${question.command} needs that removed first.`,
          );
        }
        if (answer === 'own' && question.missing) {
          // R13 (b): the CLI this computer kept is gone, and keeping it means reinstalling it — which
          // is the person's to do. Nothing stands in for it and nothing is written.
          throw new systemTasks.SystemTaskExecutionError(
            'cli_own_missing',
            `The Happier CLI this computer keeps is no longer at ${question.command}. Reinstall it there, or let Happier manage the command line.`,
          );
        }
        cliChoice = answer === 'own' ? { mode: 'own', command: question.command } : { mode: 'managed' };
        await deps.recordCliChoice(cliChoice);
        if (cliChoice.mode === 'own') {
          const removal = await deps.removePathExposure();
          if (removal.failure) {
            ctx.emit({ type: 'progress', stepId: STEP.pathExposure, message: `Could not remove happier from your PATH: ${removal.failure}` });
          }
        }
        throwIfCancelled(ctx.signal);
      }

      ctx.emit({ type: 'progress', stepId: STEP.ensureCli, message: 'Preparing the Happier command line' });
      const cli = await deps.ensureCli({ releaseRing: ring, signal: ctx.signal, onProgress: reportCliAcquisitionProgress(ctx.emit) });
      throwIfCancelled(ctx.signal);

      if (params.cliOnly) {
        // The Settings choice belongs to this home even when the active relay is served by a
        // user-owned pin. Reuse the choice/acquisition/PATH owners above, then stop before any
        // relay, credentials or service convergence. PATH keeps its existing ancillary timing.
        const pathExposure = cli.provenance === 'managed'
          ? observePathExposure(deps.ensurePathExposure({ releaseRing: ring }))
          : null;
        emitPathExposureFailure(ctx, pathExposure);
        throwIfCancelled(ctx.signal);
        return {
          machineId: null,
          cliProvenance: cli.provenance,
          cliVersion: cli.version,
          relayChanged: false,
          credentialsChanged: false,
          serviceAction: 'none',
        };
      }

      const relayTarget: RelayProfileTarget = {
        serverUrl: params.activeRelayUrl,
        webappUrl: params.activeWebappUrl,
        localServerUrl: params.activeLocalRelayUrl,
      };
      // R13 (a): the run's one relay context. The reads that must answer for the target before the
      // run may select it use `target`; every other command uses `selected`, which `server set`
      // points at the target. Neither inherits the server selection the app was launched with.
      const pinned = params.serviceTargetMode === 'pinned';
      const scope = createSetupCliScope({
        cli,
        target: relayTarget,
        processEnv: process.env,
        signal: ctx.signal,
        ...(pinned ? { serviceTargetMode: 'pinned' as const } : {}),
      });

      ctx.emit({ type: 'progress', stepId: STEP.inspectService, message: 'Checking the background service' });
      // The run's own CLI decides, not the app's earlier offer: the two are separate processes at
      // separate times, and the CLI may have changed in between (the one-CLI answer above).
      const inventory = await deps.readPinnedServiceInventory(ring, createSelectedCliInvocation({ cli, processEnv: process.env, signal: ctx.signal }));
      throwIfCancelled(ctx.signal);
      const observedDefaultBeforeRelay = !pinned && !inventory.listed ? await deps.readDaemonStatus(ring, scope.selected) : null;
      throwIfCancelled(ctx.signal);
      const sameRelay = observedDefaultBeforeRelay?.serverComparableKey != null
        && [params.activeRelayUrl, params.activeLocalRelayUrl].some((url) => url !== null && createServerUrlComparableKey(url) === observedDefaultBeforeRelay.serverComparableKey);
      if (!inventory.listed && (pinned || !sameRelay)) {
        // R10-2 — a CLI at the setup floor always lists its services; one that could not leaves
        // unknown whether the target already has its own, so nothing moves or is added blind.
        throw new systemTasks.SystemTaskExecutionError(
          'service_inventory_unavailable',
          'The Happier CLI could not list this computer\'s background services, so setup left them as they are. Try again.',
        );
      }
      if (pinned && !inventory.coexistence) {
        // N4 — a CLI that cannot run one daemon per relay would reap the other relays' daemons.
        throw new systemTasks.SystemTaskExecutionError(
          'cli_capability_missing',
          'This computer\'s Happier CLI cannot connect to more than one relay at a time. Update it, then try again.',
        );
      }
      if (!pinned && relayUrlsOverlap(inventory.relayUrls, [params.activeRelayUrl, params.activeLocalRelayUrl])) {
        // N5 — this relay already has its own service here (whether or not its status could be
        // read); moving the default-following one onto it would run two daemons for one relay.
        throw new systemTasks.SystemTaskExecutionError(
          'relay_has_own_service',
          'This computer already has its own background service for this relay, so the other one was left where it is.',
        );
      }
      const preview = await deps.previewServiceInstall(ring, scope.target);
      if (preview.installConflict?.blocking) {
        throw new systemTasks.SystemTaskExecutionError('service_install_blocked', preview.installConflict.message);
      }
      if (pinned && (preview.installConflict?.servicesToRemove.length ?? 0) > 0) {
        // "Connect to this relay too" exists so every other service keeps serving its relay. An
        // install that would remove one is not that request, whatever consent it could collect.
        throw new systemTasks.SystemTaskExecutionError(
          'service_install_blocked',
          `Connecting this computer to this relay too would remove another background service: ${preview.installConflict?.message ?? ''}`.trim(),
        );
      }
      const applyFlags: ServiceInstallApplyFlags = {
        replaceExisting: preview.installConflict !== null,
        takeover: preview.takeover !== null,
      };
      // This computer's R12 answer already settled the one thing a pure runtime switch asks — which
      // CLI the service runs — in either direction: "Let Happier manage it" moves it onto the managed
      // CLI, "Keep my own" onto the kept one (the dry-run proposes the switch toward the CLI this run
      // resolved, which is the one that answer selected). So it is not asked twice, and the switch is
      // applied by the strict install below, whose failure fails the run. Any other ownership change
      // (competing services, a manual daemon, a blocking conflict) still asks.
      const runtimeSwitchAnswered = cliChoice !== null && isRuntimeSwitchOnly(preview);
      if ((applyFlags.replaceExisting || applyFlags.takeover) && !runtimeSwitchAnswered) {
        const answer = await ctx.prompt({
          kind: SETUP_SERVICE_CONSENT_PROMPT_KIND,
          stepId: STEP.serviceConsent,
          message: 'Allow Happier to take over the existing background service on this computer?',
          data: createSetupServiceConsentPromptData({
            takeover: preview.takeover,
            message: preview.installConflict?.message ?? null,
            competingServices: preview.installConflict?.competingServices ?? [],
            servicesToRemove: preview.installConflict?.servicesToRemove ?? [],
            runtimeReplacement: preview.installConflict?.runtimeReplacement ?? null,
          }),
        });
        if (!readApproval(answer)) {
          throw new systemTasks.SystemTaskExecutionError(
            'service_consent_declined',
            'Setup stopped: the existing background service was left as it is.',
          );
        }
      }
      throwIfCancelled(ctx.signal);

      // D1 enforcement, before the first write: `server set` selects the target relay for the
      // terminal and for the default-following service, so a question asked after it could no
      // longer be answered "keep". The target relay's saved credentials — the ones
      // `--replace-existing` would replace — are read without selecting that relay (the scope's
      // `target` invocation the dry-run uses), so whatever the app saw before the run — a read the relay
      // did not answer, a terminal signed in again since, another relay's credentials — this
      // decides.
      const targetAuth = await deps.readAuthStatus(ring, scope.target);
      throwIfCancelled(ctx.signal);
      const targetAccountId = targetAuth.authenticated ? targetAuth.accountId : null;
      if (
        targetAccountId !== null
        && setupReplacesValidatedAccount({ validatedAccountId: targetAccountId, expectedAccountId: params.expectedAccountId })
        && targetAccountId !== params.replaceAccountId
      ) {
        const answer = await ctx.prompt({
          kind: SETUP_ACCOUNT_CONSENT_PROMPT_KIND,
          stepId: STEP.accountConsent,
          message: 'Move this computer to the account you are signed in to in Happier?',
          data: createSetupAccountConsentPromptData({
            currentAccountId: targetAccountId,
            currentAccountLabel: targetAuth.accountLabel ?? null,
            expectedAccountId: params.expectedAccountId,
            relayUrl: params.activeRelayUrl,
          }),
        });
        if (!readApproval(answer)) {
          throw new systemTasks.SystemTaskExecutionError(
            'account_consent_declined',
            'Setup stopped: this computer stays signed in to its current account.',
          );
        }
        throwIfCancelled(ctx.signal);
      }

      // PATH exposure is ancillary (R6): once the managed CLI exists and consent is settled it runs
      // beside the remaining service work, and nothing waits for it — the app starts its readiness
      // proof from this task's result, so awaiting a shell-profile write would hold the reveal
      // behind it.
      //
      // Its failure is reported on the run's own event stream, but only while there is still a line
      // the app will read: the desktop bridge stops reading hsetup's stdout at the result line
      // (`apps/ui/src-tauri/src/system_tasks/mod.rs:191-199`), and hsetup's stderr is surfaced only
      // when the executor dies without a result. So the outcome is emitted just before the result
      // if it has settled by then (the common case — a profile append against seconds of pairing
      // and service work), and otherwise not at all: machine settings › Terminal reads and repairs
      // PATH through the `cli.pathExposure.*` kinds, which is the surface that owns it either way.
      const pathExposure = cli.provenance === 'managed'
        ? observePathExposure(deps.ensurePathExposure({ releaseRing: ring }))
        : null;

      ctx.emit({ type: 'progress', stepId: STEP.configureRelay, message: 'Pointing this computer at your relay' });
      // What the service this run converges serves before it acts: the default-following one
      // before `server set` selects the target, or the target's own pinned service.
      // F1 — a pinned run gives the relay one saved CLI profile (added, never selected) and pins
      // every command from here on to that id, so the service, its lifecycle and its credentials
      // live where every `--all` path and a later `server use` of the same URL look. It is the
      // pinned run's counterpart of `server set` and runs at the same point: after consent.
      const selected = pinned
        ? pinInvocationToServerProfile(
          scope.selected,
          (await deps.registerRelayProfile(ring, relayTarget, createSelectedCliInvocation({ cli, processEnv: process.env, signal: ctx.signal }))).id,
        )
        : scope.selected;
      throwIfCancelled(ctx.signal);
      const observedBeforeRelay = observedDefaultBeforeRelay ?? await deps.readDaemonStatus(ring, selected);
      throwIfCancelled(ctx.signal);
      const configured = pinned
        ? pinnedRelayOf(observedBeforeRelay)
        : await deps.configureRelay(ring, relayTarget, selected);
      // A pinned service is fixed to its relay; nothing this run does moves one.
      const relayChanged = !pinned && observedBeforeRelay.serverComparableKey !== configured.comparableKey;
      throwIfCancelled(ctx.signal);

      ctx.emit({ type: 'progress', stepId: STEP.checkAuth, message: 'Checking this computer\'s sign-in' });
      const authStatus = await deps.readAuthStatus(ring, selected);
      throwIfCancelled(ctx.signal);
      const sameAccount = authStatus.authenticated && authStatus.accountId === params.expectedAccountId;
      // The claim below replaces exactly the account the pre-write read saw. Credentials that
      // changed hands in between (a terminal signing in meanwhile) were never asked about.
      const replacedAccountId = authStatus.authenticated ? authStatus.accountId : null;
      if (
        replacedAccountId !== null
        && setupReplacesValidatedAccount({ validatedAccountId: replacedAccountId, expectedAccountId: params.expectedAccountId })
        && replacedAccountId !== targetAccountId
        && replacedAccountId !== params.replaceAccountId
      ) {
        throw new systemTasks.SystemTaskExecutionError(
          'account_changed_during_setup',
          'This computer signed in to another account while setup ran, so setup stopped before pairing. Try again.',
        );
      }
      let machineId = sameAccount ? authStatus.machineId : null;
      let credentialsChanged = false;

      if (!machineId) {
        const request = await deps.requestAuthPairing(ring, selected);
        if (!sameAccount) {
          // Public material only (A2/INV2): the terminal public key, the relay and server identity
          // the app sent, and the CLI's pairing requirement (`compatible` or `v3`).
          const answer = await ctx.prompt({
            kind: SETUP_PAIRING_PROMPT_KIND,
            stepId: STEP.authRequest,
            message: 'Approve this computer in Happier to continue',
            data: createSetupPairingPromptData({
              publicKeyB64Url: request.publicKeyB64Url,
              // The builder strips any userinfo before this reaches an event (INV2).
              relayUrl: params.activeRelayUrl,
              // The key the CLI ended up configured for, not an echo of the spec: the app refuses
              // to approve a CLI that is pointed somewhere else (INV2).
              serverIdentityKey: configured.comparableKey,
              // The account this run is for, so the app can refuse to seal its content key for a
              // pairing that belongs to a different account (INV2).
              accountId: params.expectedAccountId,
              pairingRequirement: request.pairingRequirement,
              cliProvenance: cli.provenance,
              // The command this run actually resolved. When the desktop install path did not
              // place it, the app shows this verbatim to the person asked to vouch for it.
              cliCommand: cli.command,
            }),
          });
          if (!readApproval(answer)) {
            const reason = readRefusalReason(answer);
            throw new systemTasks.SystemTaskExecutionError(
              'pairing_declined',
              reason
                ? `This computer was not approved for pairing (${reason}).`
                : 'This computer was not approved for pairing.',
            );
          }
        }
        throwIfCancelled(ctx.signal);

        // A freshly approved pairing must be claimed even when a credentials file already exists
        // for another account or was rejected by the relay (`auth status` reports both as not
        // authenticated). `--replace-existing` only skips `auth wait`'s early return, so it is a
        // no-op when no file exists. The same account with no machine id keeps the early return:
        // that path returns the credentials already on disk and only registers the machine id, so
        // nothing the running daemon holds changed and it must not be restarted for it.
        ctx.emit({ type: 'progress', stepId: STEP.authWait, message: 'Finishing the pairing' });
        const claim = await deps.waitForAuthPairing(ring, {
          publicKey: request.publicKey,
          replaceExisting: !sameAccount,
        }, selected);
        if (!claim.machineId) {
          throw new systemTasks.SystemTaskExecutionError(
            'machine_id_unavailable',
            'Authenticated Relay session did not expose a machineId for this computer.',
          );
        }
        machineId = claim.machineId;
        credentialsChanged = !sameAccount;
      }
      throwIfCancelled(ctx.signal);

      const serviceAction = resolveServiceAction({
        observed: observedBeforeRelay,
        changed: relayChanged || credentialsChanged,
      });
      // The apply is the other half of the consent (R12/INV9). `install` is the CLI's idempotent
      // convergence command — it re-evaluates the conflict immediately before mutating and returns
      // early when the exact target is already converged — so whenever the dry-run demanded consent
      // it must run even though a definition already exists: that is precisely the case where the
      // approved `--replace-existing`/`--takeover` has something to remove or take over. Leaving it
      // to the start path's best-effort drift refresh would drop the removal the user approved.
      if (serviceAction === 'install' || applyFlags.replaceExisting || applyFlags.takeover) {
        ctx.emit({ type: 'progress', stepId: STEP.installService, message: 'Installing the background service' });
        // One login-start setting governs every service the app manages: a relay's own service
        // starts the way this computer's default-following one does (the Settings toggle's mode).
        const autostart = pinned
          ? (await deps.readDaemonStatus(ring, createSelectedCliInvocation({ cli, processEnv: process.env, signal: ctx.signal }))).service?.autostart ?? null
          : null;
        throwIfCancelled(ctx.signal);
        // H2 — the install that creates a connect-too service stamps it as the desktop's, so the
        // app's start, stop and login-start commands act on it (and on no service the user owns).
        await deps.installService(ring, autostart ? { ...applyFlags, autostart } : applyFlags, pinned ? markInstallDesktopManaged(selected) : selected);
        throwIfCancelled(ctx.signal);
      }
      ctx.emit({
        type: 'progress',
        stepId: serviceAction === 'restart' ? STEP.restartService : STEP.startService,
        message: serviceAction === 'restart' ? 'Restarting the background service' : 'Starting the background service',
      });
      await deps.startService(ring, {
        action: serviceAction === 'restart' ? 'restart' : 'start',
        takeover: applyFlags.takeover,
      }, selected);
      // Cancellation stops the run, it does not undo it (INV11): whatever the CLI already installed
      // or started stays discoverable for the next run to converge on, but an abandoned run must
      // not report success.
      throwIfCancelled(ctx.signal);

      emitPathExposureFailure(ctx, pathExposure);

      return {
        machineId,
        cliProvenance: cli.provenance,
        cliVersion: cli.version,
        relayChanged,
        credentialsChanged,
        serviceAction,
      };
    },
  };
}

/**
 * A pinned run selects nothing, so the relay its pairing is bound to is the one the target-scoped
 * status names (INV2) — the relay that service answers for. A status that names none cannot be
 * paired honestly.
 */
function pinnedRelayOf(observed: ServiceLifecycleObservation): Readonly<{ comparableKey: string }> {
  if (!observed.serverComparableKey) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      'The Happier CLI did not say which relay this computer would connect to.',
    );
  }
  return { comparableKey: observed.serverComparableKey };
}

/** The dry-run's only proposed change is switching which CLI the existing service runs. */
function isRuntimeSwitchOnly(preview: ServiceInstallPreview): boolean {
  const conflict = preview.installConflict;
  return preview.takeover === null
    && conflict !== null
    && conflict.runtimeReplacement !== null
    && conflict.competingServices.length === 0
    && conflict.servicesToRemove.length === 0;
}

type SettledPathExposure = Readonly<{ readFailure: () => string | null }>;

/**
 * Watches an unawaited PATH exposure so the run can report its failure if it finished in time,
 * without ever waiting for it. `readFailure()` answers `null` while it is still in flight — there
 * is nothing to report yet, and by the result line there is no longer anywhere to report it.
 */
function observePathExposure(exposure: Promise<PathExposureOutcome>): SettledPathExposure {
  let failure: string | null = null;
  void exposure.then(
    (outcome) => {
      failure = outcome.failure;
    },
    (error: unknown) => {
      failure = error instanceof Error && error.message.trim() ? error.message.trim() : 'PATH exposure failed.';
    },
  );
  return { readFailure: () => failure };
}

function emitPathExposureFailure(ctx: InteractiveSystemTaskContext, exposure: SettledPathExposure | null): void {
  const failure = exposure?.readFailure() ?? null;
  if (failure) {
    ctx.emit({ type: 'progress', stepId: STEP.pathExposure, message: `Could not add happier to your PATH: ${failure}` });
  }
}

/**
 * Executor-owned lifecycle decision (E3): the CLI executes install/start/restart, the executor
 * chooses which one because it knows what it just changed.
 */
function resolveServiceAction(params: Readonly<{
  observed: ServiceLifecycleObservation;
  changed: boolean;
}>): SetupThisComputerServiceAction {
  if (!params.observed.serviceInstalled) {
    return 'install';
  }
  if (params.observed.daemonRunning && params.changed) {
    return 'restart';
  }
  return 'start';
}

export function parseSetupThisComputerParams(params: unknown): SetupThisComputerParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected setup params to be an object.');
  }
  const record = params as Record<string, unknown>;
  const readRequired = (key: 'activeRelayUrl' | 'activeWebappUrl' | 'expectedAccountId'): string => {
    const value = typeof record[key] === 'string' ? record[key].trim() : '';
    if (!value) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `${key} is required.`);
    }
    return value;
  };
  const activeRelayUrl = readRequired('activeRelayUrl');
  const activeWebappUrl = readRequired('activeWebappUrl');
  const expectedAccountId = readRequired('expectedAccountId');
  for (const [key, value] of [['activeRelayUrl', activeRelayUrl], ['activeWebappUrl', activeWebappUrl]] as const) {
    if (!isParseableUrl(value)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `${key} must be a valid URL.`);
    }
  }

  const channel = typeof record.channel === 'string' ? record.channel.trim().toLowerCase() : '';
  if (!ACCEPTED_BOOTSTRAP_CHANNELS.includes(channel)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      `channel must be one of ${ACCEPTED_BOOTSTRAP_CHANNELS.join(', ')}.`,
    );
  }

  const localRaw = record.activeLocalRelayUrl;
  const activeLocalRelayUrl = localRaw === null || localRaw === undefined
    ? null
    : typeof localRaw === 'string' && localRaw.trim()
      ? localRaw.trim()
      : null;
  if (activeLocalRelayUrl && !isParseableUrl(activeLocalRelayUrl)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'activeLocalRelayUrl must be a valid URL when provided.');
  }

  const surface = typeof record.surface === 'string' && record.surface.trim() ? record.surface.trim() : undefined;
  const replaceAccountId = typeof record.replaceAccountId === 'string' && record.replaceAccountId.trim()
    ? record.replaceAccountId.trim()
    : undefined;
  if (record.reconsiderCli !== undefined && typeof record.reconsiderCli !== 'boolean') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'reconsiderCli must be a boolean when provided.');
  }
  if (record.cliOnly !== undefined && typeof record.cliOnly !== 'boolean') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'cliOnly must be a boolean when provided.');
  }
  if (record.cliOnly === true && record.reconsiderCli !== true) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'cliOnly requires reconsiderCli.');
  }
  const serviceTargetMode = record.serviceTargetMode;
  if (serviceTargetMode !== undefined && serviceTargetMode !== 'default-following' && serviceTargetMode !== 'pinned') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'serviceTargetMode must be default-following or pinned when provided.');
  }

  return {
    activeRelayUrl,
    activeWebappUrl,
    activeLocalRelayUrl,
    releaseRing: normalizeBootstrapChannel(channel).releaseChannel,
    expectedAccountId,
    ...(replaceAccountId ? { replaceAccountId } : {}),
    ...(record.reconsiderCli === true ? { reconsiderCli: true } : {}),
    ...(record.cliOnly === true ? { cliOnly: true } : {}),
    ...(serviceTargetMode === 'pinned' ? { serviceTargetMode } : {}),
    ...(surface ? { surface } : {}),
  };
}

/** Production PATH exposure: edits the user's shell startup files, so it is wired explicitly. */
export async function ensureManagedCliPathExposureDefault(params: Readonly<{ releaseRing: PublicReleaseRingId }>): Promise<PathExposureOutcome> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    releaseRing: params.releaseRing,
    processEnv: process.env,
  });
  return await ensureHappierCliPathExposure({ binDir: layout.shimDir, processEnv: process.env });
}

/** Production record of the R12 answer, beside the managed layout's other records. */
export async function recordHappierCliChoiceDefault(choice: HappierCliChoice): Promise<void> {
  await writeHappierCliChoice({ choice, processEnv: process.env });
}

/** Production "Keep my own" PATH cleanup: edits the user's shell startup files. */
export async function removeManagedCliPathExposureDefault(): Promise<HappierCliPathRemovalResult> {
  return await removeHappierCliPathExposure({ processEnv: process.env });
}

function createSetupThisComputerDeps(overrides: SetupThisComputerDepsInput): SetupThisComputerDeps {
  return {
    ...overrides,
    inspectCliChoice: overrides.inspectCliChoice
      ?? (async ({ reconsider }) => await inspectLocalHappierCliChoice({ processEnv: process.env, reconsider })),
    previewServiceInstall: overrides.previewServiceInstall ?? previewServiceInstall,
    readAuthStatus: overrides.readAuthStatus ?? readAuthStatus,
    readDaemonStatus: overrides.readDaemonStatus ?? readDaemonStatus,
    readPinnedServiceInventory: overrides.readPinnedServiceInventory ?? readPinnedServiceInventory,
  };
}
