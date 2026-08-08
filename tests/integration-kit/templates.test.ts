// ─────────────────────────────────────────────────────────────────────────
// Integration Kit — testes dos TEMPLATES.
//
// Um kit de onboarding sem teste apodrece em silêncio: o template é copiado
// para o repo do cliente e só falha lá, semanas depois, num `::warning::` que
// ninguém lê. Aqui os dois artefatos executáveis do kit são exercitados de
// verdade:
//
//  (a) os workflows PARSEIAM como YAML e contêm os passos obrigatórios —
//      o POST das arestas e o header de autenticação;
//  (b) o `derive-config-edges.mjs` RODA (spawn real) contra uma árvore Spring
//      mínima e produz o shape {from,to,kind,resolution,reason} correto,
//      incluindo o que ele deve RECUSAR a emitir (ambíguo / fora do --root).
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "../../integration-kit");
const TEMPLATES = path.join(KIT, "templates");
const CONFIG_DERIVER = path.join(TEMPLATES, "derive-config-edges.mjs");

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  id?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
}
interface Workflow {
  name?: string;
  on?: unknown;
  env?: Record<string, string>;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function loadWorkflow(file: string): { doc: Workflow; raw: string; steps: WorkflowStep[] } {
  const raw = readFileSync(path.join(TEMPLATES, file), "utf8");
  const doc = parseYaml(raw) as Workflow;
  const steps = Object.values(doc.jobs || {}).flatMap((j) => j.steps || []);
  return { doc, raw, steps };
}

/** `on:` é `true` (booleano) no YAML 1.1 e a string "on" no 1.2 — aceita os dois. */
function triggers(doc: Workflow): Record<string, unknown> {
  const raw = (doc.on ?? (doc as unknown as Record<string, unknown>)["true"]) as Record<string, unknown>;
  return raw || {};
}

const WORKFLOWS = ["scip-java-index.yml", "scip-typescript-index.yml"] as const;

describe("integration-kit/templates — workflows parseiam e têm os passos obrigatórios", () => {
  for (const file of WORKFLOWS) {
    describe(file, () => {
      it("parseia como YAML e declara ao menos um job com steps", () => {
        const { doc, steps } = loadWorkflow(file);
        assert.ok(doc && typeof doc === "object", "YAML não produziu um documento");
        assert.ok(doc.name, "workflow sem `name`");
        assert.ok(Object.keys(doc.jobs || {}).length > 0, "workflow sem jobs");
        assert.ok(steps.length > 0, "job sem steps");
      });

      it("dispara em push a main e permite workflow_dispatch (rodar 1x na integração)", () => {
        const on = triggers(loadWorkflow(file).doc);
        assert.ok("workflow_dispatch" in on, "sem workflow_dispatch — não dá para validar a integração sob demanda");
        const push = on.push as { branches?: string[] } | undefined;
        assert.ok(push?.branches?.includes("main"), "não dispara em push a main");
      });

      it("POSTa as arestas em /scip-edges COM o header x-api-key", () => {
        const { steps } = loadWorkflow(file);
        const post = steps.find((s) => (s.run || "").includes("/scip-edges"));
        assert.ok(post, "nenhum step POSTa em /scip-edges — o kit não entrega evidência nenhuma");
        assert.match(post!.run!, /x-api-key:\s*\$\{MANIFEST_API_KEY\}/, "POST sem header de autenticação");
        assert.match(post!.run!, /-X\s+POST/, "não é um POST");
        assert.match(post!.run!, /--data-binary\s+@edges\.json/, "não envia o edges.json derivado");
      });

      it("a chave vem de secret e o id de projeto de variable (nunca cravados)", () => {
        const { raw, doc } = loadWorkflow(file);
        assert.match(raw, /secrets\.SENTINEL_MANIFEST_API_KEY/, "API key não vem de secret");
        assert.match(String(doc.env?.MANIFEST_PROJECT_ID ?? ""), /vars\.MANIFEST_PROJECT_ID/, "MANIFEST_PROJECT_ID não vem de repository variable");
        assert.ok(!/pk_[a-f0-9]{8}/i.test(raw), "há o que parece ser uma chave real no template");
      });

      it("todo POST é auxiliar (continue-on-error) — telemetria nunca reprova o CI do produto", () => {
        const { steps } = loadWorkflow(file);
        const posts = steps.filter((s) => /curl .*-X POST|MANIFEST_URL/.test(s.run || ""));
        assert.ok(posts.length > 0);
        for (const s of posts) {
          assert.equal(s["continue-on-error"], true, `step "${s.name}" pode reprovar o CI do produto`);
        }
      });

      it("falta de configuração PULA com warning nomeado — nunca em silêncio", () => {
        const { steps } = loadWorkflow(file);
        const guard = steps.find((s) => s.id === "guard");
        assert.ok(guard, "sem step de guarda de configuração");
        assert.match(guard!.run!, /::warning title=/, "guarda não emite warning nomeado");
        assert.match(guard!.run!, /MANIFEST_PROJECT_ID/);
        assert.match(guard!.run!, /SENTINEL_MANIFEST_API_KEY/);
      });
    });
  }

  // ── As duas armadilhas que custaram investigação. Se um template perder
  //    estas flags, ele volta a produzir ZERO aresta em silêncio.
  it("Java usa `--json` no deriver (o modo binário zera os ranges do scip-java)", () => {
    const { steps } = loadWorkflow("scip-java-index.yml");
    const derive = steps.find((s) => (s.run || "").includes("derive-edges.mjs"));
    assert.ok(derive, "sem step de derivação");
    assert.match(derive!.run!, /scip print --json|\/tmp\/index\.json --json/, "não usa a saída --json");
    const print = steps.find((s) => (s.run || "").includes("scip print --json"));
    assert.ok(print, "não gera /tmp/index.json com o CLI canônico");
  });

  it("TS passa `--scip-lib` resolvido no repo (o deriver em /tmp não acha node_modules)", () => {
    const { steps } = loadWorkflow("scip-typescript-index.yml");
    const derive = steps.find((s) => (s.run || "").includes("derive-edges.mjs"));
    assert.ok(derive, "sem step de derivação");
    assert.match(derive!.run!, /--scip-lib/, "não passa --scip-lib");
    assert.match(derive!.run!, /require\.resolve\('@sourcegraph\/scip-typescript/, "não resolve a lib a partir do repo");
  });

  it("só o template Java POSTa CONFIG_PROVEN (não há resolvedor de wiring p/ Node)", () => {
    const java = loadWorkflow("scip-java-index.yml");
    const ts = loadWorkflow("scip-typescript-index.yml");
    // atenção: o step de DERIVAÇÃO também menciona "config-edges" (escreve o
    // config-edges.json). O POST é o que tem `-X POST` na URL do endpoint.
    const javaCfg = java.steps.find((s) => /-X\s+POST[\s\S]*\/config-edges/.test(s.run || ""));
    assert.ok(javaCfg, "template Java não POSTa em /config-edges");
    assert.match(javaCfg!.run!, /x-api-key:\s*\$\{MANIFEST_API_KEY\}/);
    assert.ok(
      !ts.steps.some((s) => /\/config-edges|derive-config-edges/.test(s.run || "")),
      "template TS promete CONFIG_PROVEN que não existe para Node",
    );
    const deriveCfg = java.steps.find((s) => (s.run || "").includes("derive-config-edges.mjs"));
    assert.match(deriveCfg!.run!, /--root\s+"\$\{CONFIG_ROOT_PACKAGE\}"/, "não parametriza o pacote-raiz");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) O resolvedor CONFIG_PROVEN contra uma árvore Spring mínima de verdade.
// ─────────────────────────────────────────────────────────────────────────

interface ConfigEdge { from: string; to: string; kind: string; resolution: string; reason: string }
interface ConfigOut { tool: string; schema: string; counts: Record<string, number>; edges: ConfigEdge[] }

function writeJava(root: string, fqcn: string, body: string): void {
  const parts = fqcn.split(".");
  const cls = parts.pop()!;
  const dir = path.join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${cls}.java`), `package ${parts.join(".")};\n\n${body}\n`);
}

/** Projeto Spring mínimo: 1 port resolvível, 1 ambíguo, 1 fora do --root. */
function fixtureProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cfg-proven-"));
  const src = path.join(dir, "src", "main", "java");

  // (1) resolução ÚNICA → deve virar aresta.
  writeJava(src, "com.acme.port.NotificationPort", `public interface NotificationPort { void send(String msg); }`);
  writeJava(
    src,
    "com.acme.adapter.SmtpNotificationAdapter",
    `import com.acme.port.NotificationPort;\n\n@Service\npublic class SmtpNotificationAdapter implements NotificationPort {\n  // @Service dentro de string não conta: "@Service"\n  public void send(String msg) { /* @Service em comentário também não */ }\n}`,
  );

  // (2) DOIS beans, sem @Primary → ambíguo, NÃO emitido.
  writeJava(src, "com.acme.port.StoragePort", `public interface StoragePort { void put(String k); }`);
  writeJava(src, "com.acme.adapter.S3StorageAdapter", `import com.acme.port.StoragePort;\n\n@Component\npublic class S3StorageAdapter implements StoragePort { public void put(String k) {} }`);
  writeJava(src, "com.acme.adapter.DiskStorageAdapter", `import com.acme.port.StoragePort;\n\n@Component\npublic class DiskStorageAdapter implements StoragePort { public void put(String k) {} }`);

  // (3) fora do pacote-raiz → filtrado pelo --root.
  writeJava(src, "org.vendor.LegacyPort", `public interface LegacyPort { void go(); }`);
  writeJava(src, "org.vendor.LegacyImpl", `@Service\npublic class LegacyImpl implements LegacyPort { public void go() {} }`);

  return src;
}

function runConfigDeriver(src: string, args: string[] = ["--root", "com.acme"]): ConfigOut {
  const out = execFileSync("node", [CONFIG_DERIVER, "--src", src, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out) as ConfigOut;
}

describe("integration-kit/templates/derive-config-edges.mjs — Spring mínimo real", () => {
  it("emite a aresta do port com resolução ÚNICA, no shape que o /config-edges aceita", () => {
    const res = runConfigDeriver(fixtureProject());
    const edge = res.edges.find((e) => e.from.endsWith("NotificationPort"));
    assert.ok(edge, `não emitiu a aresta do NotificationPort: ${JSON.stringify(res.edges)}`);
    assert.deepEqual(edge, {
      from: "com.acme.port.NotificationPort",
      to: "com.acme.adapter.SmtpNotificationAdapter",
      kind: "DI_RESOLVES",
      resolution: "config",
      reason: "spring-single-bean",
    });
    // o endpoint só aceita `resolution: 'config'` — qualquer outro valor é 400
    for (const e of res.edges) assert.equal(e.resolution, "config");
    assert.equal(res.schema, "adr-0035.config-proven.v1");
    assert.equal(res.tool, "config-proven");
  });

  it("interface com 2 beans e sem @Primary é CONTADA e pulada, nunca chutada", () => {
    const res = runConfigDeriver(fixtureProject());
    assert.ok(!res.edges.some((e) => e.from.endsWith("StoragePort")), "chutou um vencedor para interface ambígua");
    assert.equal(res.counts.ambiguousSkipped, 1);
    assert.equal(res.counts.proven, res.edges.length);
  });

  it("@Primary desempata e a razão registra isso", () => {
    const src = fixtureProject();
    writeJava(
      src,
      "com.acme.adapter.PreferredStorageAdapter",
      `import com.acme.port.StoragePort;\n\n@Component\n@Primary\npublic class PreferredStorageAdapter implements StoragePort { public void put(String k) {} }`,
    );
    const res = runConfigDeriver(src);
    const edge = res.edges.find((e) => e.from.endsWith("StoragePort"));
    assert.ok(edge, "o @Primary não desempatou");
    assert.equal(edge!.to, "com.acme.adapter.PreferredStorageAdapter");
    assert.equal(edge!.reason, "spring-primary");
    assert.equal(res.counts.primary, 1);
  });

  it("--root filtra: interface fora do pacote-raiz não entra", () => {
    const src = fixtureProject();
    const acme = runConfigDeriver(src);
    assert.ok(!acme.edges.some((e) => e.from.startsWith("org.vendor")), "vazou interface de fora do --root");

    const vendor = runConfigDeriver(src, ["--root", "org.vendor"]);
    assert.deepEqual(
      vendor.edges.map((e) => e.from),
      ["org.vendor.LegacyPort"],
      "trocar o --root não trocou o recorte — o filtro não está funcionando",
    );
  });

  it("sem --root FALHA explícito (o default cravado do original zerava em silêncio)", () => {
    const r = spawnSync("node", [CONFIG_DERIVER, "--src", fixtureProject()], { encoding: "utf8" });
    assert.equal(r.status, 2, "aceitou rodar sem --root");
    assert.match(r.stderr, /--root/, "não explica o que falta");
    assert.equal(r.stdout.trim(), "", "emitiu JSON mesmo falhando");
  });

  it("árvore sem nenhum bean → 0 aresta e 0 ambíguo (vazio honesto, não erro)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-empty-"));
    const src = path.join(dir, "src", "main", "java");
    writeJava(src, "com.acme.Plain", `public class Plain { }`);
    const res = runConfigDeriver(src);
    assert.equal(res.edges.length, 0);
    assert.equal(res.counts.proven, 0);
    assert.equal(res.counts.ambiguousSkipped, 0);
    assert.ok(res.counts.filesScanned >= 1, "não varreu arquivo nenhum");
  });
});
