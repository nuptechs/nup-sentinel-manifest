// ─────────────────────────────────────────────────────────────────────────
// Detector GENÉRICO de tenancy / RLS (cross-tenant / IDOR) — read-only.
//
// PROBLEMA: isolamento multi-tenant por Postgres RLS (GUC `app.current_*` +
// `CREATE POLICY ... ON <tabela>`) é a espinha de vários produtos. Uma tabela
// com dado por-tenant SEM política de RLS é um buraco de vazamento cruzado
// (IDOR) que hoje é 100% invisível pro Manifest.
//
// Este módulo detecta a CLASSE, de forma GENÉRICA e orientada a DECLARAÇÃO —
// o core NÃO conhece nenhum produto (identify/easynup) por nome. A declaração
// (quais colunas marcam tabela-tenant, quais marcadores provam escopo de tenant
// no caminho) vem de fora, com defaults genéricos.
//
// CONTRATO DE PRUDÊNCIA (nunca inferir "não tem" de "não vi"):
//   - ZERO statement de RLS no fileset ⇒ ABSTÉM: 1 diagnóstico, 0 finding
//     por-tabela (as migrations podem simplesmente não ter chegado à análise —
//     a intake do analyzer não aceita .sql/.xml hoje; wiring de escopo é passo
//     separado, de outro repo).
//   - Políticas DINÂMICAS (`DO $$ ... CREATE POLICY` em laço / `EXECUTE format`)
//     cobrem tabelas que não dá pra enumerar ⇒ ABSTÉM por-tabela.
//   - Blocos `<rollback>` do Liquibase são removidos antes de varrer (o DISABLE
//     de rollback não é o estado da migration).
//
// SAÍDA É ADVISORY/READ-ONLY: este módulo NÃO é ligado ao sentinel-emitter nem
// ao bloco de emit do pipeline. Não cria finding no orquestrador, logo NÃO pode
// abrir auto-PR em tenant algum (inclusive o easynup, que tem auto-fix ON).
// ─────────────────────────────────────────────────────────────────────────

import { extractDrizzleEntities } from "./node-backend/drizzle-schema";

export interface TenancyFileInput {
  filePath: string;
  content: string;
}

/** Declaração por-perfil. Defaults genéricos; o core nunca embute nome de produto. */
export interface TenancyDeclaration {
  /** Nomes de coluna que marcam uma tabela como por-tenant (lower-case match). */
  tenantColumns: string[];
  /** Marcadores que provam escopo de tenant num caminho de código (GUC/SDK). */
  scopeMarkers: string[];
}

export const DEFAULT_TENANCY_DECLARATION: TenancyDeclaration = {
  tenantColumns: [
    "organization_id",
    "organizationid",
    "tenant_id",
    "tenantid",
    "org_id",
    "orgid",
    "company_id",
    "account_id",
    "workspace_id",
  ],
  scopeMarkers: [
    "set_config('app",
    'set_config("app',
    "current_setting('app",
    'current_setting("app',
    "set local app.",
    "withtenant",
    "tenant_pool",
    "tenantpool",
    "data-scope",
    "datascope",
    "app.current_organization",
    "requiredatascope",
  ],
};

export interface TenancyFinding {
  kind: "TENANT_TABLE_NO_RLS";
  table: string;
  severity: "high";
  /** Arquivo onde a tabela-tenant é definida (schema/migration), quando conhecido. */
  sourceFile: string | null;
  detail: string;
}

export interface TenancyDiagnostics {
  migrationFilesSeen: number;
  rlsStatementsSeen: number;
  tenantTablesRecognized: number;
  tablesWithPolicy: number;
  tablesFlagged: number;
  dynamicPolicyDetected: boolean;
  /** há marcador de escopo de tenant no fileset? (gate do check por-rota). */
  endpointScopeDerivable: boolean;
  /** true ⇒ não houve fonte de política no fileset; nenhum finding por-tabela. */
  abstained: boolean;
  note: string;
}

export interface TenancyReport {
  findings: TenancyFinding[];
  diagnostics: TenancyDiagnostics;
}

// ── helpers ──

const MIGRATION_RE = /\.(sql|xml)$/i;

function isMigrationFile(f: TenancyFileInput): boolean {
  if (!MIGRATION_RE.test(f.filePath)) return false;
  if (f.filePath.toLowerCase().endsWith(".xml")) {
    // só Liquibase/Flyway-like: precisa parecer migration (changeSet/sql).
    return /<changeSet|<sql|liquibase|databaseChangeLog/i.test(f.content);
  }
  return true;
}

/** Remove blocos `<rollback>...</rollback>` do Liquibase (o DISABLE de rollback
 *  não representa o estado aplicado da migration). */
function stripRollback(content: string): string {
  return content.replace(/<rollback[\s\S]*?<\/rollback>/gi, " ");
}

function norm(table: string): string {
  // tira schema (public.) e aspas; lower-case para casar entre SQL e Drizzle.
  return table.replace(/["'`]/g, "").replace(/^[\w]+\./, "").toLowerCase();
}

const RE_ENABLE_RLS =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."'`]+)\s+(?:enable|force)\s+row\s+level\s+security/gi;
const RE_CREATE_POLICY =
  /create\s+policy\s+[\w"'`]+\s+on\s+(?:only\s+)?([\w."'`]+)/gi;
const RE_CREATE_TABLE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."'`]+)\s*\(([\s\S]*?)\)\s*(?:;|<\/)/gi;
// laço dinâmico de política (cobre N tabelas que não dá pra enumerar)
const RE_DYNAMIC_POLICY =
  /(?:do\s+\$\$|execute\s+format|for\s+\w+\s+in\s+select)[\s\S]{0,400}?(?:create\s+policy|row\s+level\s+security)/gi;

/**
 * Detecta tabelas-tenant sem política de RLS, de forma genérica e orientada a
 * declaração. Puro. Ver o contrato de prudência no topo do arquivo.
 */
export function detectTenancyRls(
  files: TenancyFileInput[],
  declaration: TenancyDeclaration = DEFAULT_TENANCY_DECLARATION,
): TenancyReport {
  const tenantCols = new Set(declaration.tenantColumns.map((c) => c.toLowerCase()));
  const migrations = files.filter(isMigrationFile);

  // 1) varre migrations por artefatos de RLS + CREATE TABLE.
  const rlsTables = new Set<string>();
  const sqlTenantTables = new Map<string, string>(); // table → sourceFile
  let rlsStatementsSeen = 0;
  let dynamicPolicyDetected = false;

  for (const f of migrations) {
    const content = stripRollback(f.content);

    RE_DYNAMIC_POLICY.lastIndex = 0;
    if (RE_DYNAMIC_POLICY.test(content)) dynamicPolicyDetected = true;

    let m: RegExpExecArray | null;
    RE_ENABLE_RLS.lastIndex = 0;
    while ((m = RE_ENABLE_RLS.exec(content)) !== null) {
      rlsTables.add(norm(m[1]));
      rlsStatementsSeen++;
    }
    RE_CREATE_POLICY.lastIndex = 0;
    while ((m = RE_CREATE_POLICY.exec(content)) !== null) {
      rlsTables.add(norm(m[1]));
      rlsStatementsSeen++;
    }
    RE_CREATE_TABLE.lastIndex = 0;
    while ((m = RE_CREATE_TABLE.exec(content)) !== null) {
      const table = norm(m[1]);
      const body = m[2].toLowerCase();
      // uma coluna-tenant aparece como palavra no corpo do CREATE TABLE
      const hasTenantCol = [...tenantCols].some((c) => new RegExp(`\\b${c}\\b`).test(body));
      if (hasTenantCol && !sqlTenantTables.has(table)) sqlTenantTables.set(table, f.filePath);
    }
  }

  // 2) tabelas-tenant do schema Drizzle (TS) — cobre produtos sem SQL no fileset.
  const drizzleTenantTables = new Map<string, string>(); // table → sourceFile
  try {
    for (const ent of extractDrizzleEntities(files)) {
      const hasTenantCol = ent.columns.some(
        (c) =>
          tenantCols.has(c.name.toLowerCase()) ||
          (c.column != null && tenantCols.has(c.column.toLowerCase())),
      );
      if (hasTenantCol) drizzleTenantTables.set(norm(ent.entity), ent.sourceFile);
    }
  } catch {
    /* fail-soft: schema Drizzle ausente/ilegível não derruba o detector */
  }

  // 3) união das tabelas-tenant reconhecidas.
  const tenantTables = new Map<string, string>();
  for (const [t, src] of sqlTenantTables) tenantTables.set(t, src);
  for (const [t, src] of drizzleTenantTables) if (!tenantTables.has(t)) tenantTables.set(t, src);

  // 4) escopo por-rota: só é derivável se há marcador no fileset.
  const haystack = files.map((f) => f.content.toLowerCase()).join("\n");
  const endpointScopeDerivable = declaration.scopeMarkers.some((mk) =>
    haystack.includes(mk.toLowerCase()),
  );

  const diagBase = {
    migrationFilesSeen: migrations.length,
    rlsStatementsSeen,
    tenantTablesRecognized: tenantTables.size,
    tablesWithPolicy: rlsTables.size,
    dynamicPolicyDetected,
    endpointScopeDerivable,
  };

  // 5) PRUDÊNCIA: sem nenhum statement de RLS no fileset ⇒ abstém (não concluir
  //    "não tem RLS" de "não vi fonte de política"). Idem p/ política dinâmica.
  if (rlsStatementsSeen === 0) {
    return {
      findings: [],
      diagnostics: {
        ...diagBase,
        tablesFlagged: 0,
        abstained: true,
        note:
          migrations.length === 0
            ? "Nenhuma migration (.sql/.xml) no fileset — a intake do analyzer não aceita migration hoje; detector inerte até o wiring de escopo (passo separado, outro repo)."
            : "Migrations presentes mas nenhum statement de RLS — abstém de flaggar (fonte de política pode estar fora do fileset).",
      },
    };
  }

  if (dynamicPolicyDetected) {
    return {
      findings: [],
      diagnostics: {
        ...diagBase,
        tablesFlagged: 0,
        abstained: true,
        note: "Políticas dinâmicas (laço DO/EXECUTE format) cobrem tabelas não-enumeráveis — abstém de flaggar por-tabela (evita falso-positivo).",
      },
    };
  }

  // 6) flag: tabela-tenant reconhecida SEM política de RLS.
  const findings: TenancyFinding[] = [];
  for (const [table, sourceFile] of tenantTables) {
    if (rlsTables.has(table)) continue;
    findings.push({
      kind: "TENANT_TABLE_NO_RLS",
      table,
      severity: "high",
      sourceFile,
      detail: `Tabela com coluna de tenant SEM política RLS (ENABLE ROW LEVEL SECURITY / CREATE POLICY) encontrada no fileset. Risco de vazamento cruzado (IDOR) se o isolamento depende só da aplicação.`,
    });
  }
  findings.sort((a, b) => a.table.localeCompare(b.table));

  return {
    findings,
    diagnostics: {
      ...diagBase,
      tablesFlagged: findings.length,
      abstained: false,
      note: endpointScopeDerivable
        ? "Check por-rota não emitido: atribuição marcador→rota não é confiável (escopo costuma ser global via pool/middleware)."
        : "Sem marcador de escopo de tenant no fileset — check por-rota não derivável.",
    },
  };
}

/** Markdown curto do relatório (paridade com renderCompletenessMarkdown). */
export function renderTenancyMarkdown(
  report: TenancyReport,
  opts: { projectName?: string } = {},
): string {
  const d = report.diagnostics;
  const lines: string[] = [];
  lines.push(`# Tenancy / RLS — ${opts.projectName ?? "projeto"}`);
  lines.push("");
  lines.push(`- migrations vistas: ${d.migrationFilesSeen}`);
  lines.push(`- statements de RLS: ${d.rlsStatementsSeen}`);
  lines.push(`- tabelas-tenant reconhecidas: ${d.tenantTablesRecognized}`);
  lines.push(`- tabelas com política: ${d.tablesWithPolicy}`);
  lines.push(`- tabelas flaggadas (sem RLS): ${d.tablesFlagged}`);
  lines.push(`- política dinâmica: ${d.dynamicPolicyDetected ? "sim" : "não"}`);
  lines.push(`- escopo por-rota derivável: ${d.endpointScopeDerivable ? "sim" : "não"}`);
  lines.push(`- abstido: ${d.abstained ? "sim" : "não"}`);
  lines.push(`- nota: ${d.note}`);
  if (report.findings.length) {
    lines.push("");
    lines.push("## Tabelas-tenant sem RLS");
    for (const f of report.findings) {
      lines.push(`- \`${f.table}\` — ${f.sourceFile ?? "(fonte desconhecida)"}`);
    }
  }
  return lines.join("\n");
}
