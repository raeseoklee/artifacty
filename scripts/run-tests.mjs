import { spawn } from "node:child_process";
// Keep unrelated test fixtures fast and isolated. The real ONNX integration
// suite explicitly constructs the default provider and verifies offline inference.
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ARTIFACTY_EMBEDDINGS_PROVIDER: "disabled" }
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
