import { createInterface } from "node:readline";
import { main } from "../../src/cli.js";

// The model child has its own stdin. This pipe controls the CLI's signal handlers
// without depending on platform-specific console signal injection.
const control = createInterface({ input: process.stdin });
control.on("line", (signal) => {
  if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal);
});
try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  control.close();
}
