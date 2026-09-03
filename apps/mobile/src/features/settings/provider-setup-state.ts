import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderAuthState,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/** A completed sign-in flow does not prove that saved credentials are still valid. */
export function resolveProviderSignInPresentation(
  provider: Pick<ServerProvider, "enabled" | "auth"> | undefined,
  flow: Pick<ProviderAuthState, "phase" | "message"> | null,
) {
  const signedIn = provider?.auth.status === "authenticated";
  return {
    signedIn,
    showSignOut: signedIn || (provider?.enabled === false && provider.auth.status === "unknown"),
    message: flow?.phase === "succeeded" && !signedIn ? null : (flow?.message ?? null),
  };
}

/** Keep one enabled flag when a legacy provider becomes an explicit instance. */
export function antigravityEnabledPatch(
  settings: ServerSettings,
  provider: ServerProvider,
  enabled: boolean,
): ServerSettingsPatch | null {
  if (provider.driver !== "antigravity") return null;

  const { enabled: _legacyEnabled, ...legacyConfig } = settings.providers.antigravity;
  const instance = settings.providerInstances[provider.instanceId] ?? {
    driver: provider.driver,
    config: legacyConfig,
  };
  const config =
    instance.config !== null &&
    typeof instance.config === "object" &&
    !Array.isArray(instance.config)
      ? Object.fromEntries(Object.entries(instance.config).filter(([key]) => key !== "enabled"))
      : instance.config;

  return {
    ...(provider.instanceId === "antigravity"
      ? { providers: { antigravity: DEFAULT_SERVER_SETTINGS.providers.antigravity } }
      : {}),
    providerInstances: {
      ...settings.providerInstances,
      [provider.instanceId]: { ...instance, enabled, config },
    },
  };
}

/** Setup remains available when the provider has no selectable models. */
export function providerNeedsSetup(provider: ServerProvider): boolean {
  return (
    (provider.setup?.canAuthenticate === true || provider.setup?.canInstall === true) &&
    (!provider.enabled ||
      !provider.installed ||
      provider.auth.status !== "authenticated" ||
      provider.availability === "unavailable" ||
      provider.models.length === 0)
  );
}
