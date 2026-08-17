import { describe, it, expect } from "vitest";
import {
  buildFlowUnits,
  buildSankeyModel,
  type CatalogLite,
  type EntityAccessReport,
  type ExposureReport,
  type GovernanceReport,
} from "./evidence-sankey";

const gov: GovernanceReport = {
  byPermission: [
    { permission: "UPDATE_CONTRACT", endpoints: [{ path: "/api/contract", method: "PUT" }] },
    { permission: "READ_SLA", endpoints: [{ path: "/api/sla", method: "GET" }] },
  ],
  unguarded: [{ path: "/api/health", method: "GET" }],
};
const exposure: ExposureReport = {
  exposures: [{ path: "/api/health", method: "GET", guard: "none" }],
};
const entities: EntityAccessReport = {
  entities: [{ entity: "contract", readBy: [], writtenBy: [{ path: "/api/contract", method: "PUT" }] }],
};
const catalog: CatalogLite = {
  entries: [
    { httpMethod: "PUT", httpPath: "/api/contract", observed: true, kind: "route" },
    { httpMethod: "GET", httpPath: "/api/sla", observed: false, kind: "route" },
    { httpMethod: "GET", httpPath: "/api/health", observed: false, kind: "route" },
  ],
};

describe("buildFlowUnits", () => {
  it("junta os 4 relatórios por (método+path); permissão promove sobre (sem permissão)", () => {
    const units = buildFlowUnits(gov, exposure, entities, catalog);
    expect(units).toHaveLength(3);
    const contract = units.find((u) => u.route === "PUT /api/contract")!;
    expect(contract.permission).toBe("UPDATE_CONTRACT");
    expect(contract.guard).toBe("permission");
    expect(contract.observed).toBe(true);
    expect(contract.table).toBe("contract");
  });

  it("endpoint em unguarded fica sem guarda e sem permissão", () => {
    const units = buildFlowUnits(gov, exposure, entities, catalog);
    const health = units.find((u) => u.route === "GET /api/health")!;
    expect(health.guard).toBe("none");
    expect(health.permission).toBe("(sem permissão)");
  });

  it("rota do catálogo com observed:false marca observed false (fantasma)", () => {
    const units = buildFlowUnits(gov, exposure, entities, catalog);
    const sla = units.find((u) => u.route === "GET /api/sla")!;
    expect(sla.observed).toBe(false);
  });
});

describe("buildSankeyModel", () => {
  it("gera nós de 4 colunas e links; conta stats honestas", () => {
    const model = buildSankeyModel(buildFlowUnits(gov, exposure, entities, catalog));
    expect(model.empty).toBe(false);
    const cols = new Set(model.nodes.map((n) => n.col));
    expect(cols.has(0)).toBe(true); // guarda
    expect(cols.has(1)).toBe(true); // permissão
    expect(cols.has(2)).toBe(true); // rota
    expect(model.stats.endpoints).toBe(3);
    expect(model.stats.unguarded).toBe(1);
    expect(model.stats.ghost).toBe(2); // sla + health nunca observados
    expect(model.stats.tables).toBe(1);
    expect(model.links.length).toBeGreaterThan(0);
  });

  it("link a partir do nó 'Sem guarda' é crítico", () => {
    const model = buildSankeyModel(buildFlowUnits(gov, exposure, entities, catalog));
    const critical = model.links.filter((l) => l.critical);
    expect(critical.length).toBeGreaterThan(0);
  });

  it("rota permitida-nunca-observada gera link fantasma", () => {
    const model = buildSankeyModel(buildFlowUnits(gov, exposure, entities, catalog));
    expect(model.links.some((l) => l.ghost)).toBe(true);
  });

  it("agrega 'outras (K)' quando estoura o teto de permissões", () => {
    const many: GovernanceReport = {
      byPermission: Array.from({ length: 12 }, (_, i) => ({
        permission: `P${i}`,
        endpoints: [{ path: `/api/x${i}`, method: "GET" }],
      })),
    };
    const model = buildSankeyModel(buildFlowUnits(many, null, null, null), { perm: 7, route: 9, table: 8 });
    const permNodes = model.nodes.filter((n) => n.kind === "permission");
    expect(permNodes.length).toBeLessThanOrEqual(7);
    const other = permNodes.find((n) => n.aggregated != null);
    expect(other).toBeTruthy();
    expect(other!.aggregated).toBeGreaterThan(0);
  });

  it("sem endpoints → empty (não fabrica fluxo)", () => {
    const model = buildSankeyModel([]);
    expect(model.empty).toBe(true);
    expect(model.nodes).toHaveLength(0);
  });
});

describe("normalização AUTHENTICATED (guarda ≠ permissão)", () => {
  it("endpoint cuja única 'permissão' é AUTHENTICATED vira guarda auth-only, sem permissão específica", () => {
    const gov: GovernanceReport = {
      byPermission: [{ permission: "AUTHENTICATED", endpoints: [{ path: "/api/me", method: "GET" }] }],
    };
    const units = buildFlowUnits(gov, null, null, null);
    const me = units.find((u) => u.route === "GET /api/me")!;
    expect(me.guard).toBe("auth-only"); // NÃO "permission" — não super-credita a coluna Permissão
    expect(me.permission).toBe("(sem permissão)"); // AUTHENTICATED some da coluna Permissão
  });

  it("permissão real continua guarda permission (não é rebaixada)", () => {
    const gov: GovernanceReport = {
      byPermission: [{ permission: "UPDATE_CONTRACT", endpoints: [{ path: "/api/c", method: "PUT" }] }],
    };
    const u = buildFlowUnits(gov, null, null, null)[0];
    expect(u.guard).toBe("permission");
    expect(u.permission).toBe("UPDATE_CONTRACT");
  });

  it("mesmo endpoint com AUTHENTICATED + permissão real → mantém a permissão real (guarda mais forte)", () => {
    const gov: GovernanceReport = {
      byPermission: [
        { permission: "AUTHENTICATED", endpoints: [{ path: "/api/x", method: "GET" }] },
        { permission: "READ_X", endpoints: [{ path: "/api/x", method: "GET" }] },
      ],
    };
    const u = buildFlowUnits(gov, null, null, null)[0];
    expect(u.guard).toBe("permission");
    expect(u.permission).toBe("READ_X");
  });
});
