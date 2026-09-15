import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { formatEnvironmentQueryError } from "./query";

describe("RPC query errors", () => {
  it("retains string-valued serialization defects", () => {
    expect(formatEnvironmentQueryError(Cause.die('Invalid review ID at ["entries"][0]'))).toContain(
      "Invalid review ID",
    );
  });
  it("retains typed and cross-realm errors without dumping arbitrary objects", () => {
    expect(formatEnvironmentQueryError(Cause.fail({ message: "Connect the environment" }))).toBe(
      "Connect the environment",
    );
    expect(formatEnvironmentQueryError(Cause.fail(new Error("Disconnected")))).toBe("Disconnected");
    expect(formatEnvironmentQueryError(Cause.fail({ private: "do not render" }))).not.toContain(
      "do not render",
    );
  });
});
