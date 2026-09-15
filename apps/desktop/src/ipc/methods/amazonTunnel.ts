import { DesktopAmazonTunnelAuthInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAmazonTunnelAuth from "../../amazon/DesktopAmazonTunnelAuth.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const authenticateAmazonTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AUTHENTICATE_AMAZON_TUNNEL_CHANNEL,
  payload: DesktopAmazonTunnelAuthInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.amazonTunnel.authenticate")(function* ({ url }) {
    const tunnelAuth = yield* DesktopAmazonTunnelAuth.DesktopAmazonTunnelAuth;
    return yield* tunnelAuth.authenticate(url);
  }),
});
