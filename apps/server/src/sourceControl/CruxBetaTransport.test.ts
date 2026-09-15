import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { make, isBetaRead } from "./CruxBetaTransport.ts";

const input = {
  endpoint: "https://critic-service-sso.corp.amazon.com",
  target: "com.amazon.critic.CriticService.GetRevision",
  body: { reviewRevision: { cr: "CR-1", revision: 1 } },
};
it("allows only exact read operations on the three CRUX services", () => {
  expect(isBetaRead(input)).toBe(true);
  expect(isBetaRead({ ...input, target: "com.amazon.critic.CriticService.CreateComment" })).toBe(
    false,
  );
  expect(isBetaRead({ ...input, endpoint: `${input.endpoint}.attacker.test` })).toBe(false);
});
it.effect("uses the MCS-aware client without reading cookies or retrying a denial", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const transport = yield* make;
    const result = yield* transport.call(input).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(1);
    yield* transport.call({ ...input, target: "CreateComment" }).pipe(Effect.result);
    expect(calls).toBe(1);
  }).pipe(
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (request) => {
          calls++;
          expect(request.command).toBe("my");
          expect(request.args.slice(0, 2)).toEqual(["midway", "http-post"]);
          expect(request.args.join(" ")).not.toContain("--token");
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: '{"status":403,"body":"denied"}',
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      }),
    ),
  );
});
