import { useEffect, useEffectEvent, useRef } from "react";

/** A refresh revalidates the current snapshot; only navigation discards viewer state. */
export function usePullRequestDiffRefresh({
  scopeKey,
  refreshToken,
  resetScope,
  revalidate,
}: {
  scopeKey: string;
  refreshToken: number;
  resetScope: () => void;
  revalidate: () => void;
}) {
  const reset = useEffectEvent(resetScope);
  const refresh = useEffectEvent(revalidate);
  const applied = useRef({ scopeKey, refreshToken });

  useEffect(() => {
    reset();
  }, [scopeKey]);

  useEffect(() => {
    const previous = applied.current;
    applied.current = { scopeKey, refreshToken };
    // The new scope already starts its own query. Never refresh the previous scope's
    // pages or treat an environment-wide turn notification as a new review/commit.
    if (previous.scopeKey !== scopeKey || previous.refreshToken === refreshToken) return;
    refresh();
  }, [scopeKey, refreshToken]);
}
