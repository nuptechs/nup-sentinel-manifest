import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzePythonBackend } from "../../server/analyzers/backend-ast-python";

// OBS-D08 — analisador Python com parse ESTRUTURAL (lexer + árvore de escopos por
// indentação). Prova: símbolos reais (class/def/method), call-chain intra-arquivo
// resolvido por nome único, e — o ponto crítico — NENHUM `def`/chamada fantasma de
// dentro de docstring/comentário/string entra no grafo.

const SERVICE_PY = `# módulo de serviço
import os

API_TOKEN = "def nao_eh_funcao(x): pass"  # string com 'def' DENTRO — não é símbolo

@dataclass
class OrderService:
    """Docstring com texto enganoso:
    def fantasma(self): return load_user()  # NÃO deve virar símbolo nem chamada
    """

    @app.route("/orders")
    def list_orders(self):
        # chamada dentro de comentário: fetch_all() -> ignorar
        rows = self.fetch_all()
        return format_rows(rows)

    def fetch_all(self):
        return query(
            "SELECT * FROM orders",
        )


def format_rows(rows):
    return [str(r) for r in rows]


def orphan_helper():
    return 42
`;

describe("analyzePythonBackend — símbolos reais, sem fantasmas de string/comentário", () => {
  const r = analyzePythonBackend([{ filePath: "svc/order_service.py", content: SERVICE_PY }]);

  it("parseia 1 arquivo, sem erros", () => {
    assert.equal(r.language, "python");
    assert.equal(r.filesParsed, 1);
    assert.equal(r.parseErrors.length, 0);
  });

  it("extrai a classe e seus métodos com aninhamento correto (method tem owner)", () => {
    const names = r.symbols.map((s) => `${s.kind}:${s.qualifiedName}`).sort();
    assert.ok(names.includes("class:OrderService"), "classe");
    assert.ok(names.includes("method:OrderService.list_orders"), "método aninhado");
    assert.ok(names.includes("method:OrderService.fetch_all"), "método aninhado");
    assert.ok(names.includes("function:format_rows"), "função de topo");
    assert.ok(names.includes("function:orphan_helper"), "função de topo");
    const listOrders = r.symbols.find((s) => s.qualifiedName === "OrderService.list_orders")!;
    assert.equal(listOrders.owner, "OrderService");
  });

  it("NÃO cria símbolo-fantasma de dentro de docstring/string", () => {
    assert.ok(!r.symbols.some((s) => s.name === "fantasma"), "def dentro de docstring ignorado");
    assert.ok(!r.symbols.some((s) => s.name === "nao_eh_funcao"), "def dentro de string ignorado");
  });

  it("captura decorators como dica de ponto de entrada", () => {
    const listOrders = r.symbols.find((s) => s.qualifiedName === "OrderService.list_orders")!;
    assert.deepEqual(listOrders.decorators, ["app.route"]);
  });

  it("resolve call-chain intra-arquivo por nome único; externo/ambíguo = unresolved", () => {
    const listOrders = r.symbols.find((s) => s.qualifiedName === "OrderService.list_orders")!;
    const fetchAll = r.symbols.find((s) => s.qualifiedName === "OrderService.fetch_all")!;
    const formatRows = r.symbols.find((s) => s.qualifiedName === "format_rows")!;

    // self.fetch_all() → resolvido ao método fetch_all do arquivo
    const toFetch = r.edges.find((e) => e.fromSymbolId === listOrders.id && e.calleeName === "fetch_all");
    assert.ok(toFetch, "aresta list_orders→fetch_all existe");
    assert.equal(toFetch!.resolution, "intra-file");
    assert.equal(toFetch!.toSymbolId, fetchAll.id);

    // format_rows(rows) → resolvido à função de topo
    const toFormat = r.edges.find((e) => e.fromSymbolId === listOrders.id && e.calleeName === "format_rows");
    assert.ok(toFormat);
    assert.equal(toFormat!.toSymbolId, formatRows.id);

    // query(...) é externo (não declarado no arquivo) → unresolved
    const toQuery = r.edges.find((e) => e.fromSymbolId === fetchAll.id && e.calleeName === "query");
    assert.ok(toQuery, "chamada multi-linha query() capturada (continuação por parêntese)");
    assert.equal(toQuery!.resolution, "unresolved");
    assert.equal(toQuery!.toSymbolId, undefined);
  });

  it("chamada dentro de comentário NÃO vira aresta", () => {
    assert.ok(!r.edges.some((e) => e.calleeName === "fetch_all" && e.resolution === "intra-file" &&
      // a única fetch_all válida vem de list_orders (linha de código), não do comentário
      r.symbols.find((s) => s.id === e.fromSymbolId)?.qualifiedName !== "OrderService.list_orders"));
    // load_user só aparece na docstring → nenhuma aresta
    assert.ok(!r.edges.some((e) => e.calleeName === "load_user"));
  });
});

describe("analyzePythonBackend — fail-soft e vazio", () => {
  it("lista vazia → resultado vazio determinístico", () => {
    const r = analyzePythonBackend([]);
    assert.deepEqual(r, { language: "python", symbols: [], edges: [], filesParsed: 0, parseErrors: [] });
  });

  it("ignora não-.py e arquivo vazio", () => {
    const r = analyzePythonBackend([
      { filePath: "a.ts", content: "function x(){}" },
      { filePath: "b.py", content: "   \n  \n" },
    ]);
    assert.equal(r.filesParsed, 0);
    assert.equal(r.symbols.length, 0);
  });
});
