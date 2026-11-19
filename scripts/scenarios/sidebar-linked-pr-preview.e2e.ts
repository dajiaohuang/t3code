import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect } from "e2e";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const linkPullRequests = Effect.fn("scenario.linkPullRequests")(
  function* (origin: string, threadId: string) {
    const issued = yield* makeState(T3_HOME).cli(["auth", "session", "issue", "--token-only"]);
    const { ticket } = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
        HttpClientRequest.bearerToken(issued.stdout.trim()),
      ),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
      Effect.provide(FetchHttpClient.layer),
    );
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(
            `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(NodeWS.layerWebSocketConstructor),
      ),
    );
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
    for (let number = 1; number <= 20; number++) {
      const commandId = yield* SecureRandom.SecureRandom.pipe(
        Effect.flatMap((random) => random.uuidV4()),
      );
      yield* client["orchestration.dispatchCommand"]({
        type: "thread.pull-request.link",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(threadId),
        host: "github.com",
        repository: "scenario/example",
        number,
        url: `https://github.com/scenario/example/pull/${number}`,
        source: "manual",
      });
    }
  },
  Effect.scoped,
  Effect.provide(NodeCrypto.layer),
);

test("A PR-heavy thread hover stays a compact preview", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("Preview workspace");
  const thread = await t3.thread({ project, title: "PR-heavy thread", messages: ["Start"] });
  await runPromise(linkPullRequests(app.baseUrl ?? "", thread.threadId));
  await t3.open(thread);
  await screen.getByRole("button", "PR-heavy thread, Preview workspace", { exact: true }).hover();
  try {
    await expect(screen.getByText("+17 more linked PRs")).toBeVisible();
  } finally {
    await app.screenshot("sidebar-pr-hover");
  }
});
