// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 F1 — deriver (`tools/scip-typescript/derive-edges.mjs`) no modo
// `--json` (obrigatório p/ scip-JAVA). Prova que o deriver emite `fromFile`/
// `toFile` por ponta, resolvendo o `toFile` via o índice GLOBAL de DEFINIÇÃO
// (o callee é definido NOUTRO documento), e que o dedup e o interface-impl
// carregam os arquivos. Spawn real do script (é um .mjs standalone).
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DERIVER = path.resolve(HERE, "../../tools/scip-typescript/derive-edges.mjs");

function runDeriver(idx: unknown): { edges: any[]; counts: any } {
  const dir = mkdtempSync(path.join(tmpdir(), "scip-derive-"));
  const p = path.join(dir, "index.json");
  writeFileSync(p, JSON.stringify(idx));
  const out = execFileSync("node", [DERIVER, "--json", p], { encoding: "utf8" });
  return JSON.parse(out);
}

const CALLER = "scip-java maven easynup 0.0.0 easynup/services/web/contract/CreateContractServiceV1#execute(+1).";
const CALLEE = "scip-java maven easynup 0.0.0 easynup/persistence/ContractRepository#save(+1).";
const IFACE = "scip-java maven easynup 0.0.0 easynup/persistence/CrudRepository#save(+1).";
const CALLER_FILE = "src/main/java/easynup/services/web/contract/CreateContractServiceV1.java";
const CALLEE_FILE = "src/main/java/easynup/persistence/ContractRepository.java";

describe("derive-edges.mjs --json (F1) — fromFile/toFile agnósticos a linguagem", () => {
  it("resolve toFile via o índice GLOBAL de definição (callee definido noutro doc)", () => {
    const idx = {
      documents: [
        {
          language: "java",
          relative_path: CALLER_FILE,
          occurrences: [
            { symbol: CALLER, symbol_roles: 1, range: [10, 2, 10, 9] }, // def do chamador
            { symbol: CALLEE, range: [12, 6, 12, 10] }, // call-site (ref) dentro do corpo
          ],
        },
        {
          language: "java",
          relative_path: CALLEE_FILE,
          occurrences: [{ symbol: CALLEE, symbol_roles: 1, range: [5, 2, 5, 6] }], // def do callee
        },
      ],
    };
    const { edges, counts } = runDeriver(idx);
    assert.equal(counts.proven, 1);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], {
      from: CALLER,
      to: CALLEE,
      kind: "CALLS",
      resolution: "compiler",
      fromFile: CALLER_FILE, // doc do chamador
      toFile: CALLEE_FILE, // resolvido pelo índice global (outro doc)
    });
  });

  it("interface-impl carrega os arquivos; toFile do impl vem do índice global", () => {
    const idx = {
      documents: [
        {
          language: "java",
          relative_path: CALLER_FILE,
          occurrences: [
            { symbol: CALLER, symbol_roles: 1, range: [10, 2, 10, 9] },
            { symbol: IFACE, range: [12, 6, 12, 10] }, // chama a INTERFACE
          ],
          symbols: [{ symbol: CALLEE, relationships: [{ symbol: IFACE, is_implementation: true }] }],
        },
        {
          language: "java",
          relative_path: CALLEE_FILE,
          occurrences: [{ symbol: CALLEE, symbol_roles: 1, range: [5, 2, 5, 6] }],
        },
      ],
    };
    const { edges } = runDeriver(idx);
    const iface = edges.find((e) => e.resolution === "interface-impl");
    assert.ok(iface, "esperado uma aresta interface-impl");
    assert.equal(iface.to, CALLEE); // expandiu interface→impl
    assert.equal(iface.fromFile, CALLER_FILE);
    assert.equal(iface.toFile, CALLEE_FILE); // def do impl, via índice global
  });

  it("callee externo sem def indexada → toFile omitido (aresta será órfã na agregação)", () => {
    const EXTERNAL = "scip-java maven org.springframework 6.0.0 org/springframework/data/Repository#save().";
    const idx = {
      documents: [
        {
          language: "java",
          relative_path: CALLER_FILE,
          occurrences: [
            { symbol: CALLER, symbol_roles: 1, range: [10, 2, 10, 9] },
            { symbol: EXTERNAL, range: [12, 6, 12, 10] },
          ],
        },
      ],
    };
    const { edges } = runDeriver(idx);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromFile, CALLER_FILE);
    assert.equal("toFile" in edges[0], false); // desconhecido → omitido
  });

  it("call-site FORA de método (handler/top-level) → aresta file-scoped (callee não fica isolado)", () => {
    // Reproduz o FP de dead-code: um serviço só chamado de dentro de um handler de
    // rota (arrow anônimo, sem `def` de método) parecia sem chamador. Agora a chamada
    // é atribuída ao ARQUIVO — o callee ganha aresta de ENTRADA (não é dead-code).
    const ROUTE_FILE = "server/routes/audit.routes.ts";
    const SVC_FILE = "server/services/audit-verify.service.ts";
    const VERIFY = "scip-typescript npm nupidentity 1.0.0 server/services/`audit-verify.service.ts`/verifyAuditChain().";
    const idx = {
      documents: [
        {
          language: "typescript",
          relative_path: ROUTE_FILE,
          // SEM def de método — só o call-site (como um arrow handler anônimo).
          occurrences: [{ symbol: VERIFY, range: [55, 20, 55, 36] }],
        },
        {
          language: "typescript",
          relative_path: SVC_FILE,
          occurrences: [{ symbol: VERIFY, symbol_roles: 1, range: [8, 22, 8, 38] }], // def
        },
      ],
    };
    const { edges, counts } = runDeriver(idx);
    assert.equal(counts.fileScoped, 1, "esperado 1 aresta file-scoped");
    const fs = edges.find((e) => e.toFile === SVC_FILE);
    assert.ok(fs, "callee deve ter aresta de entrada");
    assert.equal(fs.resolution, "compiler"); // callee resolvido pelo compilador
    assert.equal(fs.fromFile, ROUTE_FILE); // chamador atribuído ao ARQUIVO
    assert.equal(fs.to, VERIFY);
    assert.match(fs.from, /^scip-typescript npm nupidentity 1\.0\.0 <module>$/); // from file-level parseável
  });

  it("IMPORT-REACHABILITY: referência cross-file a símbolo de MÓDULO (barril) vira par de import", () => {
    // scip-typescript NÃO emite role IMPORT (bit 2) — imports são referência role-0. O
    // barril `export * from` não define símbolo próprio, mas o scip emite um símbolo de
    // MÓDULO do arquivo que os importadores REFERENCIAM. É assim que o barril prova uso.
    const BARREL_FILE = "server/services/permission.service.ts";
    const CONSUMER_FILE = "server/container.ts";
    const MODULE_SYM = "scip-typescript npm nupidentity 1.0.0 server/services/`permission.service.ts`/"; // símbolo de módulo (termina em /)
    const idx = {
      documents: [
        { language: "typescript", relative_path: BARREL_FILE, occurrences: [{ symbol: MODULE_SYM, symbol_roles: 1, range: [0, 0, 0, 1] }] }, // DEF do módulo
        { language: "typescript", relative_path: CONSUMER_FILE, occurrences: [{ symbol: MODULE_SYM, range: [4, 20, 4, 40] }] }, // REF role-0 (import)
      ],
    };
    const { imports, counts } = runDeriver(idx);
    assert.equal(counts.imports, 1);
    assert.deepEqual(imports[0], { from: CONSUMER_FILE, to: BARREL_FILE });
  });

  it("import-reachability: referência a símbolo EXTERNO não gera par; auto-referência ignorada", () => {
    const idx = {
      documents: [
        {
          language: "typescript",
          relative_path: "server/x.ts",
          occurrences: [
            { symbol: "scip-typescript npm typescript 5.9.3 lib/`lib.es5.d.ts`/Array#map().", range: [1, 1, 1, 4] }, // externo → ignora
            { symbol: "scip-typescript npm nupidentity 1.0.0 server/`x.ts`/local().", symbol_roles: 1, range: [2, 1, 2, 4] }, // def local
            { symbol: "scip-typescript npm nupidentity 1.0.0 server/`x.ts`/local().", range: [3, 1, 3, 4] }, // ref no MESMO arquivo → auto, ignora
          ],
        },
      ],
    };
    const { imports, counts } = runDeriver(idx);
    assert.equal(counts.imports, 0);
    assert.equal(imports.length, 0);
  });

  it("órfão para callee EXTERNO (sem def no projeto) NÃO vira file-scoped (sem nó de sistema)", () => {
    const EXTERNAL = "scip-typescript npm drizzle-orm 0.39.3 sql/`conditions.d.ts`/eq().";
    const idx = {
      documents: [
        { language: "typescript", relative_path: "server/routes/x.routes.ts", occurrences: [{ symbol: EXTERNAL, range: [3, 5, 3, 7] }] },
      ],
    };
    const { edges, counts } = runDeriver(idx);
    assert.equal(counts.fileScoped, 0); // callee externo → sem def indexada → não materializa
    assert.equal(edges.length, 0);
  });
});
