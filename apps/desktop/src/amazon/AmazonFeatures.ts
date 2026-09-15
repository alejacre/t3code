// @effect-diagnostics nodeBuiltinImport:off - the flag is read once at module load, before Effect services exist.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Amazon features (Midway/AEA browser auth, Amazon Tunnel connections) are
 * opt-in per machine rather than per build so the same T3 Custom binary works
 * on and off the Amazon network.
 *
 * `T3CODE_AMAZON=1` forces them on, `T3CODE_AMAZON=0` forces them off, and
 * otherwise they follow the presence of a Midway home (`~/.midway`), which
 * only `mwinit` creates.
 */
export function resolveAmazonFeaturesEnabled(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly exists: (path: string) => boolean;
}): boolean {
  const configured = input.env.T3CODE_AMAZON?.trim();
  if (configured === "1") return true;
  if (configured === "0") return false;
  return input.exists(NodePath.join(input.homeDirectory, ".midway"));
}

export const isAmazonFeaturesEnabled: boolean = resolveAmazonFeaturesEnabled({
  env: process.env,
  homeDirectory: NodeOS.homedir(),
  exists: (path) => {
    try {
      return NodeFS.existsSync(path);
    } catch {
      return false;
    }
  },
});
