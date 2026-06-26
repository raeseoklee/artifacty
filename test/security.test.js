import assert from "node:assert/strict";
import test from "node:test";
import { exposureWarning, requireToken, tokensEqual } from "../src/lib/security.js";

test("compares API tokens through fixed-length timing-safe digests", () => {
  assert.equal(tokensEqual("secret-token", "secret-token"), true);
  assert.equal(tokensEqual("secret-token", "wrong-token"), false);
  assert.equal(tokensEqual("secret-token", "secret-token-extra"), false);
  assert.equal(tokensEqual("", "secret-token"), false);
});

test("requires configured API tokens from headers before query or form convenience paths", () => {
  const config = { apiToken: "configured-token" };
  const url = new URL("http://127.0.0.1:8787/api/artifacts?token=query-token");
  const request = {
    headers: {
      authorization: "Bearer configured-token",
      "x-artifacty-token": "header-token"
    }
  };
  assert.doesNotThrow(() => requireToken({ request, url, body: { _token: "form-token" }, config }));

  assert.throws(
    () => requireToken({
      request: { headers: { "x-artifacty-token": "wrong-token" } },
      url: new URL("http://127.0.0.1:8787/api/artifacts"),
      config
    }),
    /Artifacty API token required/
  );
});

test("warns when binding outside loopback", () => {
  assert.equal(exposureWarning({ host: "127.0.0.1", config: { shareMode: "local" } }), "");
  const warning = exposureWarning({ host: "0.0.0.0", config: { shareMode: "lan" } });
  assert.match(warning, /listening on 0\.0\.0\.0/);
  assert.match(warning, /trusted LAN\/VPN/);
  assert.match(warning, /React rendering disabled/);
});
