// ─────────────────────────────────────────────
// openapi-generator — unit tests
//
// generateOpenAPISpec() turns the canonical Manifest into a 3.0.3 spec
// that integrators import into Postman / Stoplight / Scalar / etc.
// Bugs here ship invalid OpenAPI to customers, so contract-shape tests
// are the priority.
//
// Coverage:
//   - top-level shape (openapi, info, paths, components, security)
//   - operations are emitted per (method, path) pair
//   - operationId stable (controller.method when known)
//   - x-manifest extension carries criticality + entities + sensitivity
//   - DELETE → 204; POST/PUT → 201 + 400; secured → 401 + 403
//   - bearerAuth securityScheme appears when roles are present
//   - empty manifest still produces a valid OpenAPI 3.0.3 doc
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateOpenAPISpec } from "../../server/generators/openapi-generator.ts";
import { generateManifest } from "../../server/generators/manifest-generator.ts";
import { makeEntry, makeProject } from "../helpers/fixtures.ts";

function manifestFrom(entries: ReturnType<typeof makeEntry>[]) {
  return generateManifest(makeProject(), entries);
}

describe("generateOpenAPISpec — top-level shape", () => {
  it("returns valid OpenAPI 3.0.3 even for an empty manifest", () => {
    const spec = generateOpenAPISpec(manifestFrom([]));
    assert.equal(spec.openapi, "3.0.3");
    assert.ok(spec.info);
    assert.ok(spec.paths);
    assert.ok(spec.components);
    assert.deepEqual(spec.paths, {});
    // No roles → no security requirement at root
    assert.deepEqual(spec.security, []);
  });

  it("info.title embeds the project name", () => {
    const m = generateManifest(makeProject({ name: "best-project" }), []);
    const spec = generateOpenAPISpec(m);
    assert.match(spec.info.title, /best-project/);
  });

  it("info has x-generated-by + x-generated-at extensions", () => {
    const spec = generateOpenAPISpec(manifestFrom([]));
    assert.equal(spec.info["x-generated-by"], "Manifest");
    assert.ok(spec.info["x-generated-at"]);
  });
});

describe("generateOpenAPISpec — paths + operations", () => {
  it("emits one operation per (method, path) pair", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({ id: 1, endpoint: "/api/users", httpMethod: "GET" }),
        makeEntry({ id: 2, endpoint: "/api/users", httpMethod: "POST" }),
        makeEntry({ id: 3, endpoint: "/api/orders", httpMethod: "GET" }),
      ]),
    );
    assert.ok(spec.paths["/api/users"]);
    assert.ok(spec.paths["/api/users"].get);
    assert.ok(spec.paths["/api/users"].post);
    assert.ok(spec.paths["/api/orders"]);
    assert.ok(spec.paths["/api/orders"].get);
  });

  it("uses controller.method as stable operationId", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({
          id: 1,
          endpoint: "/api/users",
          httpMethod: "GET",
          controllerClass: "UserController",
          controllerMethod: "listUsers",
        }),
      ]),
    );
    assert.equal(spec.paths["/api/users"].get.operationId, "UserController.listUsers");
  });

  it("derives a path-based operationId when controller/method are missing", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({
          id: 1,
          endpoint: "/api/foo/bar",
          httpMethod: "POST",
          controllerClass: "",
          controllerMethod: "",
        }),
      ]),
    );
    const op = spec.paths["/api/foo/bar"].post;
    assert.match(op.operationId, /post/);
  });

  it("strips the 'Controller' suffix to build the tag", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({
          id: 1,
          endpoint: "/api/x",
          httpMethod: "GET",
          controllerClass: "OrderController",
        }),
      ]),
    );
    assert.deepEqual(spec.paths["/api/x"].get.tags, ["Order"]);
  });
});

describe("generateOpenAPISpec — x-manifest extension", () => {
  it("carries criticalityScore + entitiesTouched + sensitiveFields", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({
          id: 1,
          endpoint: "/api/x",
          httpMethod: "GET",
          criticalityScore: 75,
          entitiesTouched: ["Foo", "Bar"],
          sensitiveFieldsAccessed: ["password"],
        }),
      ]),
    );
    const ext = spec.paths["/api/x"].get["x-manifest"];
    assert.equal(ext.criticalityScore, 75);
    assert.deepEqual([...ext.entitiesTouched].sort(), ["Bar", "Foo"]);
    assert.deepEqual(ext.sensitiveFieldsAccessed, ["password"]);
  });
});

describe("generateOpenAPISpec — responses", () => {
  it("DELETE adds 204 No Content", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "DELETE" })]),
    );
    assert.ok(spec.paths["/api/x"].delete.responses["204"]);
  });

  it("POST adds 201 + 400", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "POST" })]),
    );
    const responses = spec.paths["/api/x"].post.responses;
    assert.ok(responses["201"]);
    assert.ok(responses["400"]);
  });

  it("Secured operation gets 401 + 403", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({
          id: 1,
          endpoint: "/api/x",
          httpMethod: "GET",
          requiredRoles: ["ADMIN"],
        }),
      ]),
    );
    const responses = spec.paths["/api/x"].get.responses;
    assert.ok(responses["401"]);
    assert.ok(responses["403"]);
  });

  it("Operation without roles has NO 401/403", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" })]),
    );
    const responses = spec.paths["/api/x"].get.responses;
    assert.ok(!responses["401"]);
    assert.ok(!responses["403"]);
  });
});

describe("generateOpenAPISpec — security schemes", () => {
  it("emits bearerAuth scheme + root requirement when roles exist", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", requiredRoles: ["ADMIN"] }),
      ]),
    );
    assert.ok(spec.components.securitySchemes.bearerAuth);
    assert.equal(spec.components.securitySchemes.bearerAuth.type, "http");
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
    assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  });

  it("operation.security lists required roles when present", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([
        makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", requiredRoles: ["ADMIN", "AUDITOR"] }),
      ]),
    );
    const op = spec.paths["/api/x"].get;
    assert.ok(op.security);
    assert.deepEqual(op.security![0].bearerAuth.sort(), ["ADMIN", "AUDITOR"]);
  });

  it("no roles → no securitySchemes (clean spec for public APIs)", () => {
    const spec = generateOpenAPISpec(
      manifestFrom([makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" })]),
    );
    assert.deepEqual(spec.components.securitySchemes, {});
  });
});
