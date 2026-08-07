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
});
