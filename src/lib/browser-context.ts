/**
 * Replaces openclaw `loadConfig` + `extensions/browser` `resolveBrowserConfig` / `resolveProfile`
 * for the attach-to-existing-Chrome workflow only.
 */
const DEFAULT_CDP = "http://127.0.0.1:9222";

function portFromCdpUrl(raw: string): number {
  try {
    const p = new URL(raw.trim()).port;
    if (p) {
      return Number.parseInt(p, 10);
    }
    return raw.trim().startsWith("https:") ? 443 : 80;
  } catch {
    return 9222;
  }
}

export type LoadConfigResult = {
  browser: {
    attachOnly: boolean;
    cdpUrl?: string;
    defaultProfile?: string;
  };
};

export function loadConfig(): LoadConfigResult {
  const cdp = process.env.BROWSER_CDP_URL?.trim() || DEFAULT_CDP;
  return {
    browser: {
      attachOnly: process.env.ZERO_TOKEN_LAUNCH_BROWSER === "1" ? false : true,
      cdpUrl: cdp,
      defaultProfile: "default",
    },
  };
}

export type ResolvedBrowserConfig = {
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<
    string,
    {
      cdpUrl: string;
      cdpPort: number;
    }
  >;
};

export function resolveBrowserConfig(
  cfg: LoadConfigResult["browser"] | undefined,
  _root?: LoadConfigResult,
): ResolvedBrowserConfig {
  const cdpUrl = (cfg?.cdpUrl || process.env.BROWSER_CDP_URL || DEFAULT_CDP).trim();
  const attachOnly = cfg?.attachOnly !== false;
  const defaultProfile = (cfg?.defaultProfile || "default").trim() || "default";
  return {
    attachOnly,
    defaultProfile,
    profiles: {
      [defaultProfile]: {
        cdpUrl,
        cdpPort: portFromCdpUrl(cdpUrl),
      },
    },
  };
}

export type ResolvedBrowserProfile = {
  name: string;
  cdpUrl: string;
  cdpPort: number;
  cdpHost: string;
  cdpIsLoopback: boolean;
  driver: "openclaw" | "existing-session";
  attachOnly: boolean;
  userDataDir?: string;
};

export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) {
    return null;
  }
  const u = new URL(profile.cdpUrl);
  return {
    name: profileName,
    cdpUrl: profile.cdpUrl,
    cdpPort: profile.cdpPort,
    cdpHost: u.hostname,
    cdpIsLoopback: u.hostname === "127.0.0.1" || u.hostname === "localhost",
    driver: "openclaw",
    attachOnly: false,
  };
}
