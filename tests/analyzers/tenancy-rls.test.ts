// ─────────────────────────────────────────────────────────────────────────
// tenancy-rls — detector genérico de tabelas-tenant sem RLS (cross-tenant/IDOR).
// Orientado a declaração (defaults genéricos), read-only, com contrato de
// prudência (abstém em vez de inferir "não tem" de "não vi").
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectTenancyRls } from "../../server/analyzers/tenancy-rls.ts";

// Liquibase XML (forma do easynup): ENABLE RLS + CREATE POLICY + CREATE TABLE.
const LIQUIBASE_COVERED = {
  filePath: "src/main/resources/db/migrations/0513_configuration_item.xml",
  content: `<databaseChangeLog>
  <changeSet id="1" author="x"><sql>
    CREATE TABLE configuration_item (id uuid, organization_id uuid, name text);
    ALTER TABLE configuration_item ENABLE ROW LEVEL SECURITY;
    ALTER TABLE configuration_item FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_configuration_item ON configuration_item
      USING (organization_id = current_setting('app.current_organization_id')::uuid);
  </sql>
  <rollback><sql>
    ALTER TABLE configuration_item DISABLE ROW LEVEL SECURITY;
  </sql></rollback>
  </changeSet>
</databaseChangeLog>`,
};

// Tabela-tenant SEM política (mesmo fileset, há RLS em outra tabela ⇒ não abstém).
const LIQUIBASE_UNCOVERED = {
  filePath: "src/main/resources/db/migrations/0600_invoice.xml",
  content: `<databaseChangeLog>
  <changeSet id="2" author="x"><sql>
    CREATE TABLE invoice (id uuid, organization_id uuid, total numeric);
  </sql></changeSet>
</databaseChangeLog>`,
};

describe("detectTenancyRls — detecção + prudência", () => {
  it("flagga tabela-tenant SEM política; NÃO flagga a coberta", () => {
    const { findings, diagnostics } = detectTenancyRls([LIQUIBASE_COVERED, LIQUIBASE_UNCOVERED]);
    const flagged = new Set(findings.map((f) => f.table));
    assert.ok(flagged.has("invoice"), "invoice (org_id, sem política) flaggada");
    assert.ok(!flagged.has("configuration_item"), "configuration_item (com política) NÃO flaggada");
    assert.equal(diagnostics.abstained, false);
    assert.ok(diagnostics.tablesWithPolicy >= 1);
  });

  it("rollback <DISABLE> não des-cobre a tabela", () => {
    const { findings } = detectTenancyRls([LIQUIBASE_COVERED]);
    assert.equal(findings.length, 0, "a tabela coberta segue coberta apesar do DISABLE no rollback");
  });

  it(".sql plano: CREATE POLICY cobre; tabela-tenant nua é flaggada", () => {
    const sql = {
      filePath: "migrations/0001_init.sql",
      content: `CREATE TABLE orders (id uuid, tenant_id uuid);
CREATE TABLE audit (id uuid, tenant_id uuid);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_orders ON orders USING (tenant_id = current_setting('app.tenant')::uuid);`,
    };
    const { findings } = detectTenancyRls([sql]);
    const flagged = new Set(findings.map((f) => f.table));
    assert.ok(!flagged.has("orders"));
    assert.ok(flagged.has("audit"), "audit (tenant_id, sem política) flaggada");
  });

  it("schema Drizzle (TS): tabela-tenant sem RLS é flaggada quando há RLS no fileset", () => {
    const schema = {
      filePath: "shared/schema/billing.ts",
      content: `export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
});`,
    };
    const sqlWithRls = {
      filePath: "migrations/0001.sql",
      content: `ALTER TABLE other ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON other USING (true);`,
    };
    const { findings, diagnostics } = detectTenancyRls([schema, sqlWithRls]);
    assert.ok(diagnostics.tenantTablesRecognized >= 1, "subscriptions reconhecida via Drizzle");
    assert.ok(findings.some((f) => f.table === "subscriptions"));
  });

  it("ABSTÉM: zero statement de RLS no fileset ⇒ nenhum finding por-tabela", () => {
    const schemaOnly = {
      filePath: "shared/schema/users.ts",
      content: `export const users = pgTable("users", { id: uuid("id"), organizationId: uuid("organization_id") });`,
    };
    const { findings, diagnostics } = detectTenancyRls([schemaOnly]);
    assert.equal(findings.length, 0, "sem fonte de política, abstém (não infere 'não tem')");
    assert.equal(diagnostics.abstained, true);
    assert.ok(diagnostics.note.length > 0);
  });

  it("ABSTÉM: política dinâmica (laço DO/EXECUTE format) ⇒ não flagga por-tabela", () => {
    const dynamic = {
      filePath: "scripts/rls/reharden.sql",
      content: `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('CREATE POLICY p ON %I USING (true)', r.tablename);
  END LOOP;
END $$;
CREATE TABLE widget (id uuid, organization_id uuid);`,
    };
    const { findings, diagnostics } = detectTenancyRls([dynamic]);
    assert.equal(findings.length, 0, "cobertura dinâmica não-enumerável ⇒ abstém por-tabela");
    assert.equal(diagnostics.dynamicPolicyDetected, true);
    assert.equal(diagnostics.abstained, true);
  });

  it("endpointScopeDerivable reflete presença de marcador de escopo", () => {
    const withMarker = {
      filePath: "migrations/0001.sql",
      content: `ALTER TABLE t ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON t USING (organization_id = current_setting('app.current_organization_id')::uuid);
CREATE TABLE t (id uuid, organization_id uuid);`,
    };
    const { diagnostics } = detectTenancyRls([withMarker]);
    assert.equal(diagnostics.endpointScopeDerivable, true, "current_setting('app ... é marcador de escopo");
  });
});
