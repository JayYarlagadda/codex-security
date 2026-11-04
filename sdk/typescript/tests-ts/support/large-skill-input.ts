import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CODEX_INPUT_CHARACTERS } from "../../src/codex-prompt.js";
import { resolveCodexCommand } from "../../src/runtime.js";
import { scopedTemporaryDirectory } from "./temporary-directories.js";

// Exercise the CLI and evidence reader with the supported Node runtime.
const node = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();

type Command = "validate" | "patch" | "verify-fix";
interface ModelInput {
  type?: string;
  call_id?: string;
  output?: unknown;
  content?: { text?: string }[];
}

/** Exercise the actual CLI and native Codex with scripted, local model output. */
export async function runLargeSkillInput(
  command: Command,
  signal?: "SIGINT" | "SIGTERM",
  applyPatch = false,
  windowsSandbox = "unelevated",
) {
  await using temporary = await scopedTemporaryDirectory("large skill native-");
  const root = temporary.path;
  const repository = join(root, "repository");
  const home = join(root, "home");
  await Promise.all(
    [repository, home].map((path) => mkdir(path, { mode: 0o700 })),
  );
  if (process.platform === "win32")
    await writeFile(
      join(home, "config.toml"),
      `[windows]\nsandbox = ${JSON.stringify(windowsSandbox)}\nallow_mxc = false\n`,
    );
  const finding = {
    occurrenceId: "synthetic-occurrence",
    evidence:
      "x".repeat(MAX_CODEX_INPUT_CHARACTERS) + "\nFinal evidence: café 🔎",
  };
  const source = JSON.stringify(finding);
  const input = join(root, "finding.json");
  const reader = join(root, "read-input.cjs");
  const sourceFile = join(repository, "source.js");
  const patchedSource = "export const fixed = true;\n";
  if (applyPatch) await writeFile(sourceFile, "export const fixed = false;\n");
  await writeFile(input, source, { mode: 0o600 });
  await writeFile(
    reader,
    `
const fs = require("node:fs");
const crypto = require("node:crypto");
const data = fs.readFileSync(process.argv[2]);
const original = JSON.parse(JSON.parse(data.toString("utf8").split("\\n").at(-1))[0]);
let writeDenied = false;
if (process.argv[3]) {
  try { fs.writeFileSync(process.argv[3], process.argv[4] === "apply-patch" ? ${JSON.stringify(patchedSource)} : "Synthetic forbidden write."); }
  catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
    writeDenied = true;
  }
}
console.log(JSON.stringify({
  digest: crypto.createHash("sha256").update(data).digest("hex"),
  occurrenceId: original.occurrenceId,
  tail: original.evidence.endsWith("Final evidence: café 🔎"),
  writeDenied,
}));
`,
    { mode: 0o600 },
  );

  let cli: ChildProcessWithoutNullStreams | undefined;
  let requests = 0;
  let staged = "";
  let digest = "";
  let readByWorker = false;
  const errors: string[] = [];
  const quote = (value: string) =>
    process.platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/responses")
        return Response.json({});
      try {
        const body = (await request.json()) as {
          input?: ModelInput[];
          tools?: { name?: string }[];
        };
        requests++;
        let item: object;
        if (requests === 1) {
          const prompt = body.input
            ?.flatMap((item) => item.content ?? [])
            .map(({ text }) => text ?? "")
            .find((text) =>
              text.includes("The complete task is in this UTF-8 file"),
            );
          assert.ok(prompt, "The actual request did not use file handoff");
          assert.ok(prompt.length < MAX_CODEX_INPUT_CHARACTERS);
          staged = JSON.parse(
            prompt
              .slice(prompt.indexOf("The complete task is in this UTF-8 file"))
              .split("\n")[1]!,
          );
          const task = await readFile(staged, "utf8");
          assert.deepEqual(JSON.parse(task.split("\n").at(-1)!), [source]);
          digest = createHash("sha256").update(task).digest("hex");
          if (process.platform !== "win32") {
            assert.equal((await lstat(staged)).mode & 0o777, 0o600);
            assert.equal((await lstat(dirname(staged))).mode & 0o777, 0o700);
          }
          if (signal) {
            assert.ok(cli);
            const stopped = once(cli, "close");
            cli.stdin.write(signal + "\n");
            await stopped;
            return new Response(null, { status: 200 });
          }
          assert.ok(body.tools?.some(({ name }) => name === "exec_command"));
          const cmd =
            (process.platform === "win32" ? "& " : "") +
            [
              node,
              reader,
              staged,
              ...(command === "patch"
                ? applyPatch
                  ? [sourceFile, "apply-patch"]
                  : []
                : [join(repository, "unexpected-write")]),
            ]
              .map(quote)
              .join(" ");
          item = {
            type: "function_call",
            call_id: "read-original-input",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd,
              login: false,
              shell:
                process.platform === "win32"
                  ? join(
                      process.env["SystemRoot"] ?? "C:\\Windows",
                      "System32",
                      "WindowsPowerShell",
                      "v1.0",
                      "powershell.exe",
                    )
                  : "/bin/sh",
              max_output_tokens: 1000,
            }),
          };
        } else {
          assert.equal(requests, 2);
          const output = body.input?.find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "read-original-input",
          );
          const text = output?.output;
          assert.ok(typeof text === "string", JSON.stringify(output));
          assert.ok(
            text?.includes(digest),
            "The native worker could not read the complete input:\n" + text,
          );
          assert.ok(text.includes("synthetic-occurrence"), text);
          assert.ok(text.includes('"tail":true'), text);
          if (command !== "patch")
            assert.ok(
              text.includes('"writeDenied":true'),
              "Source writes were permitted during read-only assessment:\n" +
                text,
            );
          readByWorker = true;
          item = {
            type: "message",
            id: "synthetic-response",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  command === "verify-fix"
                    ? JSON.stringify({
                        results: [
                          {
                            id: "finding-1",
                            status: "inconclusive",
                            evidence: "Synthetic file transport control.",
                          },
                        ],
                      })
                    : "Synthetic file transport control.",
              },
            ],
          };
        }
        const id = `response-${requests}`;
        const events = [
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          },
        ];
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      } catch (error) {
        errors.push(String(error));
        return new Response("Synthetic model transport failed.", {
          status: 400,
        });
      }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const environment: NodeJS.ProcessEnv = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      CODEX_SECURITY_STATE_DIR: join(root, "state"),
      CODEX_CLI_PATH: resolveCodexCommand({}).command,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
      CODEX_SECURITY_NO_UPDATE_NOTICE: "1",
    };
    for (const key of [
      "PATH",
      "SystemRoot",
      "SystemDrive",
      "ComSpec",
      "PATHEXT",
      "PYTHON",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
    ])
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    const configuration = `model_providers.synthetic={name="Synthetic",base_url="${provider.url}v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`;
    cli = spawn(
      node,
      [
        fileURLToPath(
          new URL("../fixtures/large-skill-input-driver.mjs", import.meta.url),
        ),
        command,
        input,
        "--model",
        "gpt-5.5",
        "--codex",
        'model_provider="synthetic"',
        "--codex",
        configuration,
        ...(command === "verify-fix" ? ["--json"] : []),
      ],
      { cwd: repository, env: environment, stdio: "pipe", windowsHide: true },
    );
    let stdout = "",
      stderr = "";
    cli.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    cli.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(cli, "close");
    // Leave the test runner time to report a stuck native process and clean up.
    timer = setTimeout(
      () => cli?.kill("SIGKILL"),
      Number(process.env["CODEX_SECURITY_TEST_TIMEOUT_MS"] ?? "30000") - 1000,
    );
    const [status] = await closed;
    assert.deepEqual(errors, [], stderr);
    assert.ok(staged, stderr);
    assert.equal(
      await lstat(dirname(staged)).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      ),
      true,
      "Staged evidence survived the CLI exit",
    );
    assert.equal(await readFile(input, "utf8"), source);
    if (applyPatch)
      assert.equal(await readFile(sourceFile, "utf8"), patchedSource);
    return { status: status as number, stdout, stderr, requests, readByWorker };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cli && cli.exitCode === null && cli.signalCode === null) {
      const closed = once(cli, "close");
      cli.kill("SIGKILL");
      await closed;
    }
    provider.stop(true);
  }
}
