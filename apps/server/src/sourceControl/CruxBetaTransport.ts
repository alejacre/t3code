import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  MidwayCoralClient,
  MidwayCoralAuthenticationError,
  MidwayCoralRequestError,
  type MidwayCoralCall,
} from "./MidwayCoralClient.ts";

const readTargets: Readonly<Record<string, ReadonlyArray<string>>> = {
  "https://critic-service-sso.corp.amazon.com": [
    "com.amazon.critic.CriticService.GetRevisionsByReview",
    "com.amazon.critic.CriticService.GetRevision",
    "com.amazon.critic.CriticService.GetApprovalStatus",
  ],
  "https://workspace-snapshots-sso.corp.amazon.com/": [
    "com.amazon.workspacesnapshot.WorkspaceSnapshotService.getSnapshots",
  ],
  "https://gitfarm-sso.corp.amazon.com": [
    "com.amazon.brazil.gitfarm.service.GitFarmService.rawDiff",
    "com.amazon.brazil.gitfarm.service.GitFarmService.getBlob",
  ],
};
export function isBetaRead(input: MidwayCoralCall): boolean {
  return readTargets[input.endpoint]?.includes(input.target) === true;
}

/** Use the installed MCS-aware client as the primary auth path. Never fall back after a denial. */
export const make = Effect.gen(function* () {
  const runner = yield* VcsProcess.VcsProcess;
  const call = Effect.fn("CruxBetaTransport.call")(
    function* (input: MidwayCoralCall) {
      if (!isBetaRead(input))
        return yield* new MidwayCoralRequestError({
          endpoint: input.endpoint,
          operation: input.target,
          status: 403,
        });
      const output = yield* runner.run({
        cwd: process.cwd(),
        operation: input.target,
        command: "my",
        args: [
          "midway",
          "http-post",
          "--url",
          input.endpoint,
          "--data",
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input.body),
          "--header",
          `X-Amz-Target: ${input.target}`,
          "--header",
          "Content-Type: application/json; charset=UTF-8",
          "--header",
          "Content-Encoding: amz-1.0",
        ],
        timeoutMs: 60_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
      if (output.exitCode !== 0)
        return yield* new MidwayCoralRequestError({
          endpoint: input.endpoint,
          operation: input.target,
        });
      const response = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ status: Schema.Number, body: Schema.Unknown })),
      )(output.stdout);
      if (response.status === 401 || response.status === 403)
        return yield* new MidwayCoralAuthenticationError({
          endpoint: input.endpoint,
          status: response.status,
        });
      if (response.status < 200 || response.status >= 300)
        return yield* new MidwayCoralRequestError({
          endpoint: input.endpoint,
          operation: input.target,
          status: response.status,
        });
      return typeof response.body === "string"
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(response.body)
        : response.body;
    },
    Effect.mapError((error) =>
      Schema.is(MidwayCoralAuthenticationError)(error) || Schema.is(MidwayCoralRequestError)(error)
        ? error
        : new MidwayCoralRequestError({ endpoint: "CRUX beta", operation: "read" }),
    ),
  );
  return MidwayCoralClient.of({ call });
});
export const layer = Layer.effect(MidwayCoralClient, make);
