import { expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_CODEX_INPUT_CHARACTERS as CODEX_INPUT_CHARACTERS } from "../src/codex-prompt.js";
import { withSkillPrompt } from "../src/skill-prompt.js";

const inputPath = (prompt: string): string =>
  JSON.parse(prompt.split("\n")[1]!);

test.each([
  "x".repeat(CODEX_INPUT_CHARACTERS),
  "🔎".repeat(CODEX_INPUT_CHARACTERS),
])("passes a task at the Unicode character limit unchanged", async (prompt) => {
  expect(await withSkillPrompt(prompt, async (input) => input)).toBe(prompt);
});

test("preserves the full oversized task and keeps it private until the worker exits", async () => {
  const original = `${"🔎".repeat(CODEX_INPUT_CHARACTERS)}\nFINAL_EVIDENCE`;
  let path = "";
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = withSkillPrompt(original, async (prompt) => {
    path = inputPath(prompt);
    expect(prompt.length).toBeLessThan(CODEX_INPUT_CHARACTERS);
    expect(await readFile(path, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    started();
    await stopped;
    return 130;
  });
  // Forward failures so a broken setup cannot leave this test waiting for ready.
  await Promise.race([ready, running]);
  try {
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    finish();
  }
  expect(await running).toBe(130);
  expect(
    await lstat(dirname(path)).catch(
      (error: NodeJS.ErrnoException) => error.code,
    ),
  ).toBe("ENOENT");
});

test("removes staged input and preserves a worker error", async () => {
  const error = new Error("synthetic worker failure");
  let path = "";
  await expect(
    withSkillPrompt("x".repeat(CODEX_INPUT_CHARACTERS + 1), async (prompt) => {
      path = inputPath(prompt);
      throw error;
    }),
  ).rejects.toBe(error);
  expect(
    await lstat(dirname(path)).catch(
      (error: NodeJS.ErrnoException) => error.code,
    ),
  ).toBe("ENOENT");
});
