import { test, expect } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./support/shell.js";
import { scopedTemporaryDirectory } from "./support/temporary-directories.js";

test("Node reads external input files while rejecting replaced files and escaping links", async () => {
  await using temporary = await scopedTemporaryDirectory("input files café-");
  const repository = join(temporary.path, "repository");
  const external = join(temporary.path, "external");
  await Promise.all([repository, external].map((path) => mkdir(path)));
  const input = join(external, "finding.txt");
  const content = "Synthetic evidence: café 🔎\n";
  await writeFile(input, content);
  const linked = join(repository, "linked");
  await symlink(
    external,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await runCommand(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { readRegularInputFile } from ${JSON.stringify(new URL("../dist/prompt-files.js", import.meta.url).href)};
const [input, repository, linked, content] = process.argv.slice(1);
assert.equal(await readRegularInputFile(input, repository), content);
const metadata = await lstat(input, { bigint: true });
await assert.rejects(
  readRegularInputFile(input, repository, {
    isFile: () => true, dev: metadata.dev, ino: metadata.ino + 1n,
  }),
  /Input files must remain regular files/,
);
await assert.rejects(
  readRegularInputFile(linked, repository),
  /Input files must not follow repository directory links/,
);
`,
      input,
      repository,
      join(linked, "finding.txt"),
      content,
    ],
    { timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
