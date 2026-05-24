/**
 * Unit tests for the Codelens extraction payload schema (ADR-044 Onda 1 PR 1.3).
 *
 * We only exercise the zod schema here — ingest/lookup integration with the DB
 * is covered by the running server smoke (Railway hml deploy). DB-coupled
 * tests would require provisioning Postgres in CI which the current setup
 * doesn't do.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codelensExtractionSchema } from "../server/manifest-lookup-schema.ts";

describe("codelensExtractionSchema", () => {
  it("accepts a minimal valid payload with all sections empty (defaults)", () => {
    const parsed = codelensExtractionSchema.parse({});
    assert.deepEqual(parsed.entities, []);
    assert.deepEqual(parsed.pages, []);
    assert.deepEqual(parsed.composables, []);
    assert.deepEqual(parsed.routes, []);
    assert.deepEqual(parsed.i18nKeys, []);
  });

  it("accepts a full payload spanning all 5 sections", () => {
    const payload = {
      entities: [
        {
          name: "Acceptance",
          package: "easynup.persistence.entities",
          tableName: "acceptance",
          extendsClass: "BaseEntity",
          sourcePath: "/abs/Acceptance.java",
          fields: [
            { name: "id", type: "Long", isId: true, annotations: ["Id"] },
            { name: "contract", type: "Contract", isId: false, relationship: "ManyToOne", annotations: ["ManyToOne"] },
          ],
        },
      ],
      pages: [
        {
          name: "Acceptances",
          sourcePath: "/abs/Acceptances.vue",
          imports: ["vue", "@/composables/useAuth"],
          props: [],
          emits: ["saved"],
          composables: ["useAuth"],
          i18nKeys: ["pages.acceptances.title"],
        },
      ],
      composables: [
        {
          name: "useAcceptance",
          sourcePath: "/abs/useAcceptance.ts",
          returns: ["list", "approve"],
          dependencies: ["useAuth"],
        },
      ],
      routes: [
        {
          routePath: "/contratos/aceitar",
          name: "Acceptances",
          component: "./pages/Acceptances.vue",
          paletteLabel: "Aceitação",
          paletteCategory: "contracts",
          permissions: ["contracts.approve_acceptance"],
          hasPaletteMeta: true,
          sourcePath: "/abs/router.ts",
        },
      ],
      i18nKeys: [
        { key: "pages.acceptances.title", usageCount: 3, sampleFiles: ["/abs/Acceptances.vue"] },
      ],
    };

    const parsed = codelensExtractionSchema.parse(payload);
    assert.equal(parsed.entities.length, 1);
    assert.equal(parsed.entities[0].fields[1].relationship, "ManyToOne");
    assert.equal(parsed.routes[0].hasPaletteMeta, true);
    assert.equal(parsed.i18nKeys[0].usageCount, 3);
  });

  it("rejects entity without name", () => {
    assert.throws(() =>
      codelensExtractionSchema.parse({
        entities: [{ package: "x", sourcePath: "/abs/x.java", fields: [] }],
      }),
    );
  });

  it("rejects route without routePath", () => {
    assert.throws(() =>
      codelensExtractionSchema.parse({
        routes: [{ name: "X", sourcePath: "/abs/router.ts", hasPaletteMeta: false }],
      }),
    );
  });

  it("rejects unknown relationship value on field", () => {
    assert.throws(() =>
      codelensExtractionSchema.parse({
        entities: [
          {
            name: "X",
            sourcePath: "/abs/X.java",
            fields: [{ name: "y", type: "Y", isId: false, relationship: "WeirdAssoc" as never, annotations: [] }],
          },
        ],
      }),
    );
  });

  it("rejects i18nKeys.sampleFiles with more than 5 entries", () => {
    assert.throws(() =>
      codelensExtractionSchema.parse({
        i18nKeys: [
          {
            key: "k",
            usageCount: 6,
            sampleFiles: ["a", "b", "c", "d", "e", "f"],
          },
        ],
      }),
    );
  });
});
