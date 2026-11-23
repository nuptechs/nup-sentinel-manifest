// ─────────────────────────────────────────────────────────────────────────
// codelens-extractor — IRMÃO React (.tsx/.jsx) do extractor de rotas Vue.
//
// identify usa wouter (`<Route path="/x" component={X} />`, X importado de
// `@/pages/XPage`) e react-router v6 (`<Route path element={<X/>} />`). O
// extractor Vue não via nada disso → /lookup rota→tela e a âncora broken-screen
// do Sentinel ficavam vazios pra front React. Atrás da opção `react` (OFF
// default ⇒ byte-a-byte o Vue-only).
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractCodelens } from "../../server/analyzers/frontend/codelens-extractor.ts";

// Mini-réplica do identify: App.tsx (wouter) + páginas .tsx sob @/pages.
const APP_WOUTER = {
  filePath: "client/src/App.tsx",
  content: `import { Route, Switch } from "wouter";
import LoginPage from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/users/:id" component={UsersPage} />
    </Switch>
  );
}
`,
};

const LOGIN_PAGE = {
  filePath: "client/src/pages/LoginPage.tsx",
  content: `import { useState } from "react";
import { useTranslation } from "react-i18next";
export default function LoginPage() {
  const { t } = useTranslation();
  const q = useQueryClient();
  return <div>{t("login.title")}</div>;
}
`,
};

const USERS_PAGE = {
  filePath: "client/src/pages/UsersPage.tsx",
  content: `export function UsersPage() { return <div>users</div>; }
`,
};

// react-router v6 JSX com element={<X/>}.
const APP_RR = {
  filePath: "web/src/routes.tsx",
  content: `import { Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
export const AppRoutes = () => (
  <Routes>
    <Route path="/dashboard" element={<Dashboard />} />
  </Routes>
);
`,
};

const DASHBOARD = {
  filePath: "web/src/pages/Dashboard.tsx",
  content: `export default function Dashboard() { return <div/>; }
`,
};

const REACT_FILES = [APP_WOUTER, LOGIN_PAGE, USERS_PAGE, APP_RR, DASHBOARD];

describe("codelens-extractor — irmão React (ADR-044)", () => {
  it("OFF (default): não extrai rota nem página React — Vue-only byte-a-byte", () => {
    const { payload } = extractCodelens(REACT_FILES);
    assert.equal(payload.routes.length, 0, "sem a opção, nenhuma rota React");
    assert.equal(payload.pages.length, 0, "sem a opção, nenhuma página .tsx");
  });

  it("ON: extrai rotas wouter `component={X}` e resolve o componente até o .tsx", () => {
    const { payload } = extractCodelens(REACT_FILES, { react: true });
    const byPath = new Map(payload.routes.map((r) => [r.routePath, r]));
    assert.ok(byPath.has("/login"), "rota /login extraída");
    assert.equal(byPath.get("/login")!.component, "client/src/pages/LoginPage.tsx",
      "@/pages/LoginPage (default import) resolve ao .tsx real");
    assert.ok(byPath.has("/users/:id"));
    assert.equal(byPath.get("/users/:id")!.component, "client/src/pages/UsersPage.tsx",
      "named import resolve ao .tsx real");
  });

  it("ON: extrai react-router v6 `element={<X/>}`", () => {
    const { payload } = extractCodelens(REACT_FILES, { react: true });
    const r = payload.routes.find((x) => x.routePath === "/dashboard");
    assert.ok(r, "rota /dashboard extraída");
    assert.equal(r!.component, "web/src/pages/Dashboard.tsx", "element={<Dashboard/>} resolve ao .tsx");
  });

  it("ON: trata .tsx como páginas (name, imports, hooks, i18n)", () => {
    const { payload } = extractCodelens(REACT_FILES, { react: true });
    const login = payload.pages.find((p) => p.sourcePath === "client/src/pages/LoginPage.tsx");
    assert.ok(login, "LoginPage.tsx vira página");
    assert.equal(login!.name, "LoginPage");
    assert.ok(login!.composables.includes("useState"), "hook useState capturado");
    assert.ok(login!.composables.includes("useTranslation"));
    assert.ok(login!.i18nKeys.includes("login.title"), "chave i18n capturada");
  });

  it("ON: diagnóstico conta rotas resolvidas ao arquivo", () => {
    const { diagnostics } = extractCodelens(REACT_FILES, { react: true });
    assert.ok(diagnostics.routesComponentResolvedToFile >= 3, "3 rotas resolvidas ao .tsx");
    assert.ok(diagnostics.routerFiles.includes("client/src/App.tsx"));
  });

  it("ON com fonte Vue: fluxo Vue intacto (irmão React não interfere)", () => {
    const VUE = [
      {
        filePath: "src/router.ts",
        content: `import { createRouter } from "vue-router";
const routes = [{ path: "/home", component: () => import("./pages/Home.vue") }];
export default createRouter({ routes });
`,
      },
      { filePath: "src/pages/Home.vue", content: `<template><div/></template>` },
    ];
    const off = JSON.stringify(extractCodelens(VUE).payload);
    const on = JSON.stringify(extractCodelens(VUE, { react: true }).payload);
    assert.equal(on, off, "fonte Vue: ON==OFF (React não adiciona nada)");
  });
});
