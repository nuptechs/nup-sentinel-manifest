import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractCodelens } from "../server/analyzers/frontend/codelens-extractor.ts";
import { codelensExtractionSchema } from "../server/manifest-lookup-schema.ts";

const routerFile = {
  filePath: "frontend/src/router.ts",
  content: `
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Home',
    component: () => import('./pages/HomePage.vue'),
    meta: { palette: { labelKey: 'nav.items.home', category: 'home' } },
  },
  {
    path: '/contratos/aceitar',
    name: 'Acceptances',
    component: () => import('@/pages/Acceptances.vue'),
    meta: { palette: { labelKey: 'nav.items.acc', category: 'contracts', permission: 'contracts.approve' } },
  },
  { path: '/bkms', redirect: '/regras' },
  {
    path: '/parent',
    component: () => import('./pages/Parent.vue'),
    children: [
      { path: 'child', name: 'Child', component: () => import('./pages/Child.vue') },
    ],
  },
]
export default createRouter({ history: createWebHistory(), routes })
`,
};

const pageFile = {
  filePath: "frontend/src/pages/Acceptances.vue",
  content: `
<template>
  <div>{{ $t('pages.acceptances.title') }}</div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { useAuth } from '@/composables/useAuth'
const props = defineProps<{ contractId: string }>()
const emit = defineEmits(['saved'])
const { user } = useAuth()
</script>
`,
};

const composableFile = {
  filePath: "frontend/src/composables/useAcceptance.ts",
  content: `
import { ref } from 'vue'
import { useAuth } from './useAuth'
export function useAcceptance() {
  const { user } = useAuth()
  const list = ref([])
  function approve() {}
  return { list, approve }
}
`,
};

const testNoise = {
  filePath: "frontend/src/__tests__/foo.test.ts",
  content: `const routes = [{ path: '/a' }, { path: '/b' }]`,
};

describe("codelens-extractor", () => {
  const { payload, diagnostics } = extractCodelens([routerFile, pageFile, composableFile, testNoise]);

  it("produces a payload valid against codelensExtractionSchema", () => {
    const parsed = codelensExtractionSchema.safeParse(payload);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.format()));
  });

  it("extracts routes with .vue component path and router.ts as sourcePath", () => {
    const home = payload.routes.find((r) => r.routePath === "/");
    assert.ok(home);
    assert.equal(home.name, "Home");
    assert.equal(home.component, "./pages/HomePage.vue");
    assert.equal(home.sourcePath, "frontend/src/router.ts");
    assert.equal(home.hasPaletteMeta, true);
    assert.equal(home.paletteLabel, "nav.items.home");
    assert.equal(home.paletteCategory, "home");
  });

  it("captures palette permission", () => {
    const acc = payload.routes.find((r) => r.routePath === "/contratos/aceitar");
    assert.ok(acc);
    assert.deepEqual(acc.permissions, ["contracts.approve"]);
  });

  it("joins child route paths to the parent, exactly once (no double-emit)", () => {
    const children = payload.routes.filter((r) => r.name === "Child");
    assert.equal(children.length, 1);
    assert.equal(children[0].routePath, "/parent/child");
    assert.equal(children[0].component, "./pages/Child.vue");
    // nenhuma rota fantasma `child` (sem o prefixo do pai)
    assert.equal(payload.routes.some((r) => r.routePath === "child"), false);
  });

  it("resolves component to the repo-relative .vue when it exists in the fileset", () => {
    // Acceptances.vue ESTÁ no fileset; @/ → frontend/src/
    const acc = payload.routes.find((r) => r.routePath === "/contratos/aceitar");
    assert.ok(acc);
    assert.equal(acc.component, "frontend/src/pages/Acceptances.vue");
  });

  it("keeps redirect routes (no component) without inventing one", () => {
    const bkms = payload.routes.find((r) => r.routePath === "/bkms");
    assert.ok(bkms);
    assert.equal(bkms.component, undefined);
  });

  it("ignores test/storybook/mock files (no phantom routes)", () => {
    assert.equal(payload.routes.some((r) => r.routePath === "/a"), false);
    assert.equal(diagnostics.routerFiles.includes("frontend/src/__tests__/foo.test.ts"), false);
  });

  it("extracts a page: name=basename, sourcePath=.vue, props/emits/composables/i18n", () => {
    const page = payload.pages.find((p) => p.sourcePath === "frontend/src/pages/Acceptances.vue");
    assert.ok(page);
    assert.equal(page.name, "Acceptances");
    assert.ok(page.props.includes("contractId"));
    assert.ok(page.emits.includes("saved"));
    assert.ok(page.composables.includes("useAuth"));
    assert.ok(page.i18nKeys.includes("pages.acceptances.title"));
  });

  it("extracts a composable with returns and dependencies", () => {
    const c = payload.composables.find((x) => x.name === "useAcceptance");
    assert.ok(c);
    assert.equal(c.sourcePath, "frontend/src/composables/useAcceptance.ts");
    assert.ok(c.returns.includes("list"));
    assert.ok(c.returns.includes("approve"));
    assert.ok(c.dependencies.includes("useAuth"));
  });

  it("aggregates i18n keys with usage + sample files", () => {
    const k = payload.i18nKeys.find((x) => x.key === "pages.acceptances.title");
    assert.ok(k);
    assert.ok(k.usageCount >= 1);
    assert.ok(k.sampleFiles.length <= 5);
  });
});
