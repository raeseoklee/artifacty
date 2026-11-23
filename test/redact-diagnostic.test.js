import test from "node:test";
import assert from "node:assert/strict";
import { redactDiagnostic } from "../src/lib/security.js";

test("diagnostic output keeps the cause and masks credentials", () => {
  const output = [
    "npm error code E401",
    "npm error Unable to authenticate, need: Basic realm=\"registry\"",
    "GET https://ci-user:s3cret-pass@registry.example.test/artifacty",
    "//registry.example.test/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abc.def.ghi",
    "ARTIFACTY_API_TOKEN=arty_0123456789abcdefghij",
    "token: ghp_abcdefghijklmnopqrstuvwxyz012345"
  ].join("\r\n");
  const masked = redactDiagnostic(output);
  assert.match(masked, /npm error code E401/);
  assert.match(masked, /https:\/\/\*\*\*\*@registry\.example\.test\/artifacty/);
  for (const secret of ["s3cret-pass", "ci-user", "npm_abcdef", "abc.def.ghi", "arty_0123", "ghp_abcdef"]) assert.ok(!masked.includes(secret), secret);
  assert.ok(!masked.includes("\r"));
});

test("diagnostic output keeps only the last lines and a bounded length", () => {
  const masked = redactDiagnostic(Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"), { maxLines: 3 });
  assert.equal(masked, "line 97\nline 98\nline 99");
  assert.equal(redactDiagnostic("x".repeat(10000)).length, 4000);
  assert.equal(redactDiagnostic(undefined), "");
});
