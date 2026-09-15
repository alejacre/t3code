// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings and prepares the Linux desktop entry synchronously before app services are available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import { renderUrlHandlerDesktopEntry } from "./DesktopLinuxUrlHandler.ts";
import { isAmazonFeaturesEnabled } from "../amazon/AmazonFeatures.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

const CHROMIUM_AUTH_POLICIES = [
  {
    policyName: "AuthServerAllowlist",
    switchName: "auth-server-whitelist",
  },
  {
    policyName: "AuthNegotiateDelegateAllowlist",
    switchName: "auth-negotiate-delegate-whitelist",
  },
] as const;

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export interface DesktopPreReadyCommandLineWriter extends DesktopPreReadyCommandLineReader {
  readonly appendSwitch: (switchName: string, value?: string) => void;
}

function readManagedChromePolicy(policyName: string): string | null {
  let username: string | null = null;
  try {
    username = NodeOS.userInfo().username;
  } catch {
    // The machine-wide managed preference remains available without a user lookup.
  }
  const policyPaths = [
    "/Library/Managed Preferences/com.google.Chrome.plist",
    ...(username === null
      ? []
      : [`/Library/Managed Preferences/${username}/com.google.Chrome.plist`]),
  ];

  for (const policyPath of policyPaths) {
    try {
      const value = NodeChildProcess.execFileSync(
        "/usr/bin/plutil",
        ["-extract", policyName, "raw", "-o", "-", policyPath],
        {
          encoding: "utf8",
          timeout: 1_000,
        },
      ).trim();
      if (value !== "") return value;
    } catch {
      // Managed Chrome policy may be absent on non-Amazon or partially enrolled Macs.
    }
  }
  return null;
}

export function configureAmazonChromiumAuthentication(input: {
  readonly commandLine: DesktopPreReadyCommandLineWriter;
  readonly amazonEnabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly readManagedPolicy: (policyName: string) => string | null;
}): void {
  if (!input.amazonEnabled || input.platform !== "darwin") return;

  for (const policy of CHROMIUM_AUTH_POLICIES) {
    if (input.commandLine.hasSwitch(policy.switchName)) continue;
    const value = input.readManagedPolicy(policy.policyName)?.trim();
    if (value) {
      input.commandLine.appendSwitch(policy.switchName, value);
    }
  }
}

function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
    });

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    configureAmazonChromiumAuthentication({
      commandLine: Electron.app.commandLine,
      amazonEnabled: isAmazonFeaturesEnabled,
      platform,
      readManagedPolicy: readManagedChromePolicy,
    });

    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const applicationsDir = NodePath.posix.join(
          process.env.XDG_DATA_HOME?.trim() ||
            NodePath.posix.join(NodeOS.homedir(), ".local", "share"),
          "applications",
        );
        NodeFS.mkdirSync(applicationsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
          renderUrlHandlerDesktopEntry({
            displayName: resolveDesktopAppBranding({
              isDevelopment: linux.isDevelopment,
              appVersion: Electron.app.getVersion(),
            }).displayName,
            execTarget: process.env.APPIMAGE?.trim() || process.execPath,
            scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
          }),
          "utf8",
        );
      } catch {
        // The URL handler retries with the full environment and logs failures.
      }
      // Chromium caches its portal registration during startup. Set the identity
      // before any asynchronous work can initialize it with Electron's default.
      Electron.app.setDesktopName(linux.linuxDesktopEntryName);
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
