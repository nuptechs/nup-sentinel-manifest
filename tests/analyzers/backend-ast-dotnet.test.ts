import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeDotnetBackend } from "../../server/analyzers/backend-ast-dotnet";

// OBS-D08 — analisador .NET (C#) com parse ESTRUTURAL por chaves (lexer que mascara
// strings/char/comentários + pilha de escopos namespace→tipo→método). Prova:
// símbolos reais, distinção declaração×chamada, call-chain intra-arquivo, e nenhum
// fantasma de dentro de string verbatim/comentário.

const CONTROLLER_CS = `using System;

namespace Shop.Api
{
    // comentário com Ghost() que NÃO deve virar chamada
    public class OrderController
    {
        private readonly IRepo _repo;

        public OrderController(IRepo repo)
        {
            _repo = repo;
        }

        [HttpGet("/orders")]
        public IActionResult List()
        {
            var sql = @"SELECT * FROM orders WHERE x = ""y""  -- FakeCall() aqui dentro";
            var rows = FetchAll();
            return Ok(Format(rows));
        }

        private List<string> FetchAll()
        {
            if (true) { return Query("x"); }
            return null;
        }

        private string Format(object rows) => rows.ToString();

        private void OrphanMethod()
        {
            Console.WriteLine("nunca chamado");
        }
    }
}
`;

describe("analyzeDotnetBackend — símbolos e call-chain reais, sem fantasmas", () => {
  const r = analyzeDotnetBackend([{ filePath: "Api/OrderController.cs", content: CONTROLLER_CS }]);

  it("parseia 1 arquivo, sem erros", () => {
    assert.equal(r.language, "csharp");
    assert.equal(r.filesParsed, 1);
    assert.equal(r.parseErrors.length, 0);
  });

  it("extrai a classe (com namespace) e os métodos/construtor", () => {
    const names = r.symbols.map((s) => `${s.kind}:${s.qualifiedName}`).sort();
    assert.ok(names.includes("class:Shop.Api.OrderController"), "classe qualificada pelo namespace");
    assert.ok(names.includes("method:Shop.Api.OrderController.OrderController"), "construtor");
    assert.ok(names.includes("method:Shop.Api.OrderController.List"), "método com corpo");
    assert.ok(names.includes("method:Shop.Api.OrderController.FetchAll"));
    assert.ok(names.includes("method:Shop.Api.OrderController.Format"), "método expression-body");
    assert.ok(names.includes("method:Shop.Api.OrderController.OrphanMethod"));
  });

  it("campo e controle de fluxo NÃO viram método; atributo vira decorator", () => {
    assert.ok(!r.symbols.some((s) => s.name === "_repo"), "campo não é método");
    assert.ok(!r.symbols.some((s) => s.name === "if"), "if() não é declaração");
    const list = r.symbols.find((s) => s.name === "List")!;
    assert.deepEqual(list.decorators, ["HttpGet"]);
  });

  it("resolve call-chain intra-arquivo; externo = unresolved", () => {
    const list = r.symbols.find((s) => s.qualifiedName === "Shop.Api.OrderController.List")!;
    const fetchAll = r.symbols.find((s) => s.qualifiedName === "Shop.Api.OrderController.FetchAll")!;
    const format = r.symbols.find((s) => s.qualifiedName === "Shop.Api.OrderController.Format")!;

    const toFetch = r.edges.find((e) => e.fromSymbolId === list.id && e.calleeName === "FetchAll");
    assert.ok(toFetch, "List→FetchAll");
    assert.equal(toFetch!.resolution, "intra-file");
    assert.equal(toFetch!.toSymbolId, fetchAll.id);

    const toFormat = r.edges.find((e) => e.fromSymbolId === list.id && e.calleeName === "Format");
    assert.ok(toFormat);
    assert.equal(toFormat!.toSymbolId, format.id);

    // Ok(...) e Query(...) são externos → unresolved
    const toOk = r.edges.find((e) => e.calleeName === "Ok");
    assert.ok(toOk);
    assert.equal(toOk!.resolution, "unresolved");
  });

  it("chamada em string verbatim / comentário NÃO vira aresta", () => {
    assert.ok(!r.edges.some((e) => e.calleeName === "FakeCall"), "FakeCall está em string verbatim");
    assert.ok(!r.edges.some((e) => e.calleeName === "Ghost"), "Ghost está em comentário");
  });
});

describe("analyzeDotnetBackend — fail-soft e vazio", () => {
  it("lista vazia → vazio determinístico", () => {
    const r = analyzeDotnetBackend([]);
    assert.deepEqual(r, { language: "csharp", symbols: [], edges: [], filesParsed: 0, parseErrors: [] });
  });
  it("ignora não-.cs", () => {
    const r = analyzeDotnetBackend([{ filePath: "a.py", content: "def x(): pass" }]);
    assert.equal(r.filesParsed, 0);
  });
});
