import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { runCodexSkillCommand } from "../src/cli.js";
import type { JsonObject } from "../src/config.js";
import { capture } from "./cli-fixtures.js";
import { runTestInSubprocess } from "./support/test-subprocess.js";
import { scopedTemporaryDirectory } from "./support/temporary-directories.js";

test("isolated validation preserves configured Windows backends at the child boundary", async () => {
  const name =
    "isolated validation preserves configured Windows backends at the child boundary";
  if (runTestInSubprocess(import.meta.path, name)) return;
  await using temporary = await scopedTemporaryDirectory(
    "skill Windows config-",
  );
  const script = join(temporary.path, "capture.mjs");
  await writeFile(
    script,
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(process.argv.slice(2))}}));\n',
  );
  const cases: [JsonObject, JsonObject | undefined][] = [
    [{}, undefined],
    [{ windows: { sandbox: "elevated" } }, { sandbox: "elevated" }],
    [
      { windows: { sandbox: "unelevated", allow_mxc: false } },
      { sandbox: "unelevated", allow_mxc: false },
    ],
    [
      { features: { elevated_windows_sandbox: false } },
      { sandbox: "unelevated" },
    ],
    [{ features: { elevated_windows_sandbox: true } }, { sandbox: "elevated" }],
    [
      {
        profile: "selected",
        profiles: { selected: { windows: { sandbox: "unelevated" } } },
      },
      { sandbox: "unelevated" },
    ],
  ];
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  for (const platform of ["linux", "win32"]) {
    for (const [config, expected] of cases) {
      const path = join(temporary.path, "config.toml");
      const contents = stringify(config);
      await writeFile(path, contents);
      const stdout = capture();
      const stderr = capture();
      try {
        Object.defineProperty(process, "platform", { value: platform });
        const status = await runCodexSkillCommand(
          [script, "exec", "--ignore-user-config"],
          {
            command: "validate",
            auth: "auto",
            modelProvider: "synthetic",
            codexOverrides: {
              model_providers: {
                synthetic: { name: "Synthetic", requires_openai_auth: false },
              },
            },
            stdout: stdout.stream,
            stderr: stderr.stream,
          },
          { command: process.execPath },
          { CODEX_HOME: temporary.path },
        );
        expect(status, stderr.text()).toBe(0);
        const args = JSON.parse(stdout.text()) as string[];
        const forwarded = args.find((arg) => arg.startsWith("windows="));
        expect(
          forwarded === undefined
            ? undefined
            : (parse(forwarded) as JsonObject)["windows"],
        ).toEqual(platform === "win32" ? expected : undefined);
        expect(args.slice(0, 2)).toEqual(["exec", "--ignore-user-config"]);
      } finally {
        Object.defineProperty(process, "platform", original);
      }
      expect(await Bun.file(path).text()).toBe(contents);
    }
  }
});
