import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const MAX_ACP_ERROR_DATA_CHARS = 300;

/**
 * Agents put the useful part of a failure in JSON-RPC `data` while `message`
 * stays generic ("Internal error"). Keep both so the turn error tells the user
 * what the agent actually rejected instead of a bare code name.
 */
export function formatAcpRequestErrorDetail(error: EffectAcpErrors.AcpRequestError): string {
  const base = `${error.message} (ACP ${error.code})`;
  const data = formatAcpErrorData(error.data);
  return data ? `${base}: ${data}` : base;
}

function formatAcpErrorData(data: unknown): string | undefined {
  let text: string | undefined;
  if (typeof data === "string") {
    text = data;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const preferred = [record.detail, record.details, record.message, record.error].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (typeof preferred === "string") {
      text = preferred;
    } else {
      try {
        text = JSON.stringify(data);
      } catch {
        text = undefined;
      }
    }
  } else if (data !== undefined && data !== null) {
    text = String(data);
  }
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ACP_ERROR_DATA_CHARS
    ? `${trimmed.slice(0, MAX_ACP_ERROR_DATA_CHARS)}…`
    : trimmed;
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: formatAcpRequestErrorDetail(error),
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
