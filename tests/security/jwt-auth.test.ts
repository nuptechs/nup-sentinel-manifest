import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveJwksUrl } from "../../server/middleware/jwt-auth.ts";

describe("OIDC JWKS resolution", () => {
  it("uses NuPIdentity's published JWKS endpoint by default", () => {
    assert.equal(
      resolveJwksUrl("https://identify.nuptechs.com/").toString(),
      "https://identify.nuptechs.com/api/oidc/jwks",
    );
  });

  it("honors an explicit JWKS URI for another OIDC provider", () => {
    assert.equal(
      resolveJwksUrl("https://identity.example", "https://identity.example/keys/current").toString(),
      "https://identity.example/keys/current",
    );
  });
});