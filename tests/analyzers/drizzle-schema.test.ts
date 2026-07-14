// ─────────────────────────────────────────────
// drizzle-schema — unit tests (ADR-0015 Onda 1, D4/D5 / balde node-backend)
//
// Extração de entidades Drizzle (pgTable/sqliteTable/mysqlTable) e o índice
// símbolo→entidade usado pelo parser Express pra ligar rota→entidade.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractDrizzleEntities,
  drizzleSymbolIndex,
} from "../../server/analyzers/node-backend/drizzle-schema.ts";

const SCHEMA = {
  filePath: "services/gateway/src/db/schema.ts",
  content: `import { pgTable, integer, text, varchar } from "drizzle-orm/pg-core";

export const webhookEvents = pgTable("webhook_event", {
  id: integer("id").primaryKey(),
  payload: text("payload"),
});

export const auditLog = pgTable("audit_log", {
  id: integer("id").primaryKey(),
  actor: varchar("actor", { length: 255 }),
});
`,
};

describe("extractDrizzleEntities — pgTable → entidade (nome de tabela)", () => {
  it("captura símbolo, nome de tabela e colunas", () => {
    const ents = extractDrizzleEntities([SCHEMA]);
    assert.equal(ents.length, 2);
    const wh = ents.find((e) => e.symbol === "webhookEvents")!;
    assert.equal(wh.entity, "webhook_event");
    assert.deepEqual(
      wh.columns.map((c) => c.name).sort(),
      ["id", "payload"],
    );
    const id = wh.columns.find((c) => c.name === "id")!;
    assert.equal(id.type, "integer");
    assert.equal(id.column, "id");
    assert.equal(id.isId, true);
  });

  it("é determinístico e ordenado por símbolo", () => {
    const ents = extractDrizzleEntities([SCHEMA]);
    assert.deepEqual(ents.map((e) => e.symbol), ["auditLog", "webhookEvents"]);
  });

  it("ignora arquivos sem tabela Drizzle e arquivos .java", () => {
    assert.deepEqual(extractDrizzleEntities([{ filePath: "x.ts", content: "const a = 1;" }]), []);
    assert.deepEqual(
      extractDrizzleEntities([{ filePath: "E.java", content: 'pgTable("t", {})' }]),
      [],
    );
  });

  it("índice símbolo→entidade resolve em O(1)", () => {
    const idx = drizzleSymbolIndex(extractDrizzleEntities([SCHEMA]));
    assert.equal(idx.get("auditLog")?.entity, "audit_log");
    assert.equal(idx.get("desconhecido"), undefined);
  });
});
