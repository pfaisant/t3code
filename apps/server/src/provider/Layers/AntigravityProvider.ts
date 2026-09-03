import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";

type SessionSetupResult = AcpSessionRuntimeStartResult["sessionSetupResult"];

/** Keep the native model IDs, including model-specific thinking levels. */
export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const seen = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    return [
      {
        slug: entry.value,
        name: entry.name.trim() ? entry.name : entry.value,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface AntigravityProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}

/** Health uses initialize only. Session callbacks supply account-specific metadata. */
export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: { displayName: "Antigravity", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in T3 Code settings.",
      },
    }),
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.map((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const result = yield* options.probe.pipe(Effect.timeoutOption("15 seconds"), Effect.result);
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : "Antigravity did not respond to its local health check within 15 seconds.";
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const authenticated = draft.auth.status === "authenticated";
      const message =
        errorMessage ??
        (authenticated
          ? undefined
          : draft.auth.status === "unauthenticated"
            ? SIGN_IN_MESSAGE
            : AUTH_UNCHECKED_MESSAGE);
      return {
        ...state,
        draft: {
          ...draft,
          installed: !missingInstallation,
          version: initialized?.agentInfo?.version || draft.version,
          status: errorMessage ? "error" : authenticated ? "ready" : "warning",
          checkedAt: updatedAt,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration:
                  supportsTextGeneration && draft.auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    });
    return options.stampIdentity(next.draft);
  });

  const managed = yield* makeManagedServerProvider({
    maintenanceCapabilities:
      options.maintenanceCapabilities ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("antigravity"),
        packageName: null,
      }),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((state) => publishSnapshot(options.stampIdentity(state.draft))),
      ),
  });

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    const before = yield* SubscriptionRef.get(metadata);
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return state;
      }
      const { message: _previousMessage, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: settings.enabled ? "ready" : "disabled",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
          checkedAt: updatedAt,
          models: buildAntigravityModelsFromSession(started.sessionSetupResult),
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  { cwd, checkedAt: updatedAt, slashCommands, skills: [] },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          draft: {
            ...state.draft,
            auth: { status: "unauthenticated" },
            status: settings.enabled ? "warning" : "disabled",
            message: SIGN_IN_MESSAGE,
            checkedAt: updatedAt,
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
            supportsTextGeneration: false,
          },
        }) satisfies AntigravityProviderState,
    );
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (cwd: string) {
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    return workspace
      ? {
          ...snapshot,
          slashCommands: workspace.slashCommands,
          skills: workspace.skills,
        }
      : snapshot;
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onAvailableCommands,
    onSignedOut: clearAccountMetadata(),
    onAuthRequired: clearAccountMetadata(),
    snapshotForCwd,
  };
});
