// ─────────────────────────────────────────────
// reasoner/grounding — o GATE generalizado + livro-razão MEDIDO.
//
// Generaliza o applyGroundingGate da narrativa para qualquer âncora (nó/aresta):
// claim com anchorId fora do conjunto provado é REMOVIDO (off-map), texto vazio
// idem, um por âncora, e a saída carrega proposed/kept/rejected/groundingRate.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { groundClaims, emptyLedger, type GroundableClaim } from "../../server/reasoner/grounding.ts";

const proven = new Set(["N:a", "N:b", "N:c"]);

describe("reasoner/grounding — groundClaims", () => {
  it("mantém claim ancorado a um id provado", () => {
    const { kept, ledger } = groundClaims([{ anchorId: "N:a", text: "vivo" }], proven);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].anchorId, "N:a");
    assert.equal(ledger.proposed, 1);
    assert.equal(ledger.kept, 1);
    assert.equal(ledger.rejected, 0);
    assert.equal(ledger.groundingRate, 1);
  });

  it("REMOVE (não rebaixa) claim off-map — anchorId inexistente", () => {
    const claims: GroundableClaim[] = [
      { anchorId: "N:a", text: "válido" },
      { anchorId: "N:INVENTADO", text: "alucinação" },
    ];
    const { kept, ledger } = groundClaims(claims, proven);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].anchorId, "N:a");
    assert.equal(ledger.rejected, 1);
    assert.equal(ledger.rejectedClaims[0].reason, "off-map");
    assert.equal(ledger.rejectedClaims[0].anchorId, "N:INVENTADO");
    // livro-razão MEDIDO: metade sobreviveu
    assert.equal(ledger.groundingRate, 0.5);
  });

  it("descarta texto vazio como empty-text (não off-map)", () => {
    const { kept, ledger } = groundClaims([{ anchorId: "N:a", text: "   " }], proven);
    assert.equal(kept.length, 0);
    assert.equal(ledger.rejectedClaims[0].reason, "empty-text");
  });

  it("um claim por âncora — o primeiro vence, duplicata é ignorada", () => {
    const { kept, ledger } = groundClaims(
      [
        { anchorId: "N:b", text: "primeiro" },
        { anchorId: "N:b", text: "segundo" },
      ],
      proven,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].text, "primeiro");
    // duplicata não conta como rejeitada nem como kept extra
    assert.equal(ledger.kept, 1);
    assert.equal(ledger.rejected, 0);
  });

  it("preserva campos extras do claim (é genérico sobre T)", () => {
    const { kept } = groundClaims([{ anchorId: "N:c", text: "x", tier: "strong", extra: 42 } as any], proven);
    assert.equal((kept[0] as any).tier, "strong");
    assert.equal((kept[0] as any).extra, 42);
  });

  it("lista nula/vazia → livro-razão vacuamente honesto (rate 1)", () => {
    const { kept, ledger } = groundClaims(null, proven);
    assert.equal(kept.length, 0);
    assert.equal(ledger.proposed, 0);
    assert.equal(ledger.groundingRate, 1);
  });

  it("emptyLedger é o livro-razão do caminho determinístico", () => {
    const l = emptyLedger();
    assert.deepEqual(l, { proposed: 0, kept: 0, rejected: 0, groundingRate: 1, rejectedClaims: [] });
  });

  it("nunca lança com entrada malformada", () => {
    assert.doesNotThrow(() => groundClaims([{ anchorId: 5, text: null } as any, null as any], proven));
  });
});
