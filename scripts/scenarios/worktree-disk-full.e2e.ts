import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const decodeLaunched = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

test(
  "A full filesystem is explained when worktree setup fails",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hook = `${project}/.git/hooks/post-checkout`;
        yield* fs.writeFileString(
          hook,
          "#!/bin/sh\necho 'fatal: No space left on device' >&2\nexit 1\n",
        );
        yield* fs.chmod(hook, 0o755);
      }),
    );
    const started = await runPromise(
      run(
        process.execPath,
        [
          "apps/server/src/bin.ts",
          "thread",
          "start",
          project,
          "hello",
          "--worktree",
          "main",
          "--json",
          "--base-dir",
          T3_HOME,
        ],
        { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      ).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout))),
    );
    const { cli } = makeState(T3_HOME);
    const pairing = await runPromise(cli(["auth", "pairing", "create", "--json"]));
    const { credential } = JSON.parse(pairing.stdout) as { credential: string };
    await app.open(`/pair#token=${encodeURIComponent(credential)}`);
    await browser.waitForURL(/^(?!.*\/pair(?:[?#]|$))https?:/, { timeout: 60_000 });
    const environmentId = await runPromise(
      HttpClient.get(`${app.baseUrl ?? ""}/.well-known/t3/environment`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(Schema.Struct({ environmentId: Schema.String })),
        ),
        Effect.map((environment) => environment.environmentId),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    await app.open(`/${environmentId}/${started.threadId}`);
    await screen
      .getByText("Workspace preparation failed during provision worktree", { exact: false })
      .first()
      .waitFor({ timeout: 60_000 });
    // Redact the synthetic project's host-specific path and machine name in captures.
    await browser.evaluate(() => {
      const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (nodes.nextNode()) {
        const node = nodes.currentNode;
        node.nodeValue =
          node.nodeValue
            ?.replace(/[A-Z]:\\[^()\n]*?\\demo/gi, "[test project]")
            .replace(/DESKTOP-[A-Z0-9]+/gi, "Scenario") ?? null;
      }
    });
    await app.screenshot("worktree-failure");
    await expect(
      screen.getByText("No space left on device", { exact: false }).first(),
    ).toBeVisible();
  },
);
