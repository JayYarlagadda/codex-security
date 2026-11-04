import { expect, test } from "bun:test";
import { runLargeSkillInput } from "./support/large-skill-input.js";

const modes =
  process.platform === "win32" ? ["unelevated", "elevated"] : [undefined];

for (const mode of modes) {
  const suffix = mode === undefined ? "" : ` (${mode})`;
  test(
    "native patch changes source after reading complete oversized evidence" +
      suffix,
    async () => {
      const result = await runLargeSkillInput("patch", undefined, true, mode);
      expect(result.status, result.stderr).toBe(0);
      expect(result.readByWorker).toBe(true);
      expect(result.requests).toBe(2);
      expect(result.stderr).toContain("Patch applied. Files changed: 1.");
    },
  );

  for (const command of ["validate", "patch", "verify-fix"] as const) {
    test(`native ${command} reads complete oversized evidence and removes its input${suffix}`, async () => {
      const result = await runLargeSkillInput(command, undefined, false, mode);
      expect(result.status, result.stderr).toBe(command === "validate" ? 0 : 2);
      expect(result.readByWorker).toBe(true);
      expect(result.requests).toBe(2);
      if (command === "verify-fix") {
        expect(JSON.parse(result.stdout).results).toEqual([
          {
            id: "finding-1",
            status: "inconclusive",
            evidence: "Synthetic file transport control.",
          },
        ]);
      } else if (command === "patch") {
        expect(result.stderr).toContain(
          "No patch was applied; 0 files changed.",
        );
      }
    });
  }
}

for (const command of ["validate", "patch", "verify-fix"] as const) {
  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`native ${command} removes oversized evidence after ${signal}`, async () => {
      const result = await runLargeSkillInput(command, signal);
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout).toBe("");
      expect(result.requests).toBe(1);
    });
  }
}
