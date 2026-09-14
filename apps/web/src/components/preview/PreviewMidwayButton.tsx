import {
  MIDWAY_REFRESH_FAILURE_COPY,
  type EnvironmentId,
  type MidwayRefreshFailureReason,
  MidwayRefreshFailureReason as MidwayRefreshFailureReasonSchema,
} from "@t3tools/contracts";
import { KeyRound } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

/** Maps the reason token the main process embeds in its error message back to copy. */
export function midwayRefreshFailureReason(cause: unknown): MidwayRefreshFailureReason {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    MidwayRefreshFailureReasonSchema.literals.find((reason) =>
      message.includes(`failed: ${reason}.`),
    ) ?? "readFailed"
  );
}

/** "until 07:59" in the user's locale, or nothing when the expiry is unknown. */
export function formatMidwaySessionExpiry(iso: string | undefined): string {
  if (iso === undefined) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return ` until ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * T3 Custom: one-click Midway sign-in for the profile the tab is in. Copies
 * the live SSO session from Chrome (without closing it) or from `mwinit`, so
 * internal sites open without a fresh hardware-key prompt.
 */
export function PreviewMidwayButton({
  environmentId,
  profileId,
}: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  if (!previewBridge) return null;
  const bridge = previewBridge;

  const refresh = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void bridge
      .refreshMidwaySession({ environmentId, targetProfileId: profileId })
      .then((result) => {
        const from =
          result.source === "chrome"
            ? `Chrome${result.sourceProfileName ? ` (${result.sourceProfileName})` : ""}`
            : "mwinit";
        toastManager.add({
          type: "success",
          title: "Midway session refreshed",
          description: `${result.imported} ${result.imported === 1 ? "cookie" : "cookies"} from ${from}${formatMidwaySessionExpiry(result.sessionExpiresAt)}. Reload the page to use it.`,
        });
      })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not refresh Midway",
          description: MIDWAY_REFRESH_FAILURE_COPY[midwayRefreshFailureReason(cause)],
        });
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={refresh}
            aria-label="Refresh Midway session"
            type="button"
            disabled={busy}
          />
        }
      >
        {busy ? <Spinner className="size-3.5" /> : <KeyRound />}
      </TooltipTrigger>
      <TooltipPopup>Refresh Midway session (from Chrome or mwinit)</TooltipPopup>
    </Tooltip>
  );
}
