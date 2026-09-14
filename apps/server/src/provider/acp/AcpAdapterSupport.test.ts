import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  formatAcpRequestErrorDetail,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("keeps the JSON-RPC code and data in the request error detail", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("kiro"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { detail: "image exceeds 5 MB" },
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    if (error._tag !== "ProviderAdapterRequestError") return;
    expect(error.detail).toBe("Internal error (ACP -32603): image exceeds 5 MB");
  });

  it("formats string and structured error data without exceeding the cap", () => {
    expect(
      formatAcpRequestErrorDetail(
        new EffectAcpErrors.AcpRequestError({
          code: -32000,
          errorMessage: "Auth",
          data: "  login expired ",
        }),
      ),
    ).toBe("Auth (ACP -32000): login expired");
    expect(
      formatAcpRequestErrorDetail(
        new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
      ),
    ).toBe("Internal error (ACP -32603)");
    expect(
      formatAcpRequestErrorDetail(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
          data: { reason: "x".repeat(400) },
        }),
      ).length,
    ).toBeLessThan(360);
  });
});
