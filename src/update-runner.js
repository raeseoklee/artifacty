#!/usr/bin/env node
import { runWebUpdate } from "./lib/web-update.js";

runWebUpdate(process.argv[2]).catch(() => {
  console.error("Artifacty update worker could not finish. Inspect its persisted status and user service.");
  process.exitCode = 1;
});
