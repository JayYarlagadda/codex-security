import { expect, test } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { main } from "../src/cli.js";
import { MAX_CODEX_INPUT_CHARACTERS as CODEX_INPUT_CHARACTERS } from "../src/codex-prompt.js";
import { dependencies, FakeSignals, fakeResult } from "./cli-fixtures.js";
import { createCliTest } from "./support/cli-run.js";
import { scopedTemporaryDirectory } from "./support/temporary-directories.js";

for (const command of ["validate", "patch", "verify-fix"]) {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    `${command} cancels oversized input setup on %s without starting a worker`,
    async (signal, status) => {
      await using temporary = await scopedTemporaryDirectory("large-cancel-");
      const finding = join(temporary.path, "finding.json");
      await writeFile(
        finding,
        JSON.stringify({ evidence: "x".repeat(CODEX_INPUT_CHARACTERS) }),
      );
      class SetupSignals extends FakeSignals {
        override add(name: string, listener: () => void): void {
          super.add(name, listener);
          if (name === signal) queueMicrotask(listener);
        }
      }
      const signals = new SetupSignals();
      let launched = false;
      const { runCli } = createCliTest(main);
      expect(
        await runCli(
          [command, finding],
          dependencies({
            currentDirectory: temporary.path,
            signals,
            onCodex: () => {
              launched = true;
              return 0;
            },
          }),
        ),
      ).toBe(status);
      expect(launched).toBe(false);
      for (const listeners of signals.listeners.values())
        expect(listeners.size).toBe(0);
    },
  );
}

test("measures the complete task, including context, and cleans up a failed worker", async () => {
  await using temporary = await scopedTemporaryDirectory("large-context-");
  const { runCli, stderr } = createCliTest(main);
  const context = "reviewer context ".repeat(70_000) + "FINAL_CONTEXT";
  let staged = "";
  expect(
    await runCli(
      ["validate", "Synthetic finding", "--context", context],
      dependencies({
        currentDirectory: temporary.path,
        onCodex: async (_args, output, _environment, input) => {
          staged = JSON.parse(input!.split("\n")[1]!);
          const task = await readFile(staged, "utf8");
          expect(task).toContain(JSON.stringify(context));
          expect(task).toContain(JSON.stringify(["Synthetic finding"]));
          output?.stderr.write("Synthetic worker failure.\n");
          return 1;
        },
      }),
    ),
  ).toBe(1);
  expect(stderr.text()).toContain("Synthetic worker failure.");
  expect(
    await lstat(dirname(staged)).catch(
      (error: NodeJS.ErrnoException) => error.code,
    ),
  ).toBe("ENOENT");
});

test("preserves saved finding IDs and order around one oversized finding", async () => {
  await using temporary = await scopedTemporaryDirectory(
    "large-saved-finding-",
  );
  const result = fakeResult(["high", "high", "high"]);
  result.findings.findings = result.findings.findings.map((finding, index) => ({
    ...finding,
    findingId: `csf_${index}`,
    occurrenceId: `occ_${index}`,
    summary:
      index === 1
        ? "x".repeat(CODEX_INPUT_CHARACTERS) + "FINAL_EVIDENCE"
        : "Synthetic evidence.",
  }));
  const { runCli, stdout } = createCliTest(main);
  const observed: string[] = [];
  const staged: string[] = [];
  expect(
    await runCli(
      [
        "verify-fix",
        "--scan",
        "synthetic-scan",
        "--severity",
        "high",
        "--json",
      ],
      dependencies({
        currentDirectory: temporary.path,
        result,
        onWorkbench: () =>
          JSON.parse(
            JSON.stringify({
              scan: {
                scanId: "synthetic-scan",
                targetPath: temporary.path,
                findings: result.findings.findings,
              },
            }),
          ),
        onCodex: async (_args, output) => {
          let task = output!.appServer!.prompt;
          if (task.startsWith("The complete task is in this UTF-8 file")) {
            const path: string = JSON.parse(task.split("\n")[1]!);
            staged.push(path);
            task = await readFile(path, "utf8");
          }
          const findings = JSON.parse(
            task.split("\n").at(-1)!,
          ) as typeof result.findings.findings;
          for (const finding of findings) {
            const expected = result.findings.findings.find(
              ({ occurrenceId }) => occurrenceId === finding.occurrenceId,
            );
            expect(expected).toBeDefined();
            expect(finding).toEqual(expected!);
            observed.push(finding.occurrenceId);
          }
          output!.stdout.write(
            JSON.stringify({
              results: findings.map(({ occurrenceId }) => ({
                id: occurrenceId,
                status: "fixed",
                evidence: "Synthetic transport control.",
              })),
            }),
          );
          return 0;
        },
      }),
    ),
  ).toBe(0);
  expect(observed).toEqual(["occ_0", "occ_1", "occ_2"]);
  expect(
    JSON.parse(stdout.text()).results.map(({ id }: { id: string }) => id),
  ).toEqual(observed);
  expect(staged).toHaveLength(1);
  for (const path of staged)
    expect(
      await lstat(dirname(path)).catch(
        (error: NodeJS.ErrnoException) => error.code,
      ),
    ).toBe("ENOENT");
});
