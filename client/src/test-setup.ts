import "@testing-library/jest-dom/vitest";

// jsdom não implementa ResizeObserver — o <ResponsiveContainer> do recharts
// (usado nos gráficos do Mapa Epistêmico) o exige no mount. Stub no-op: os
// gráficos não renderizam com dimensão 0 no jsdom, mas não quebram, e a
// legenda/estatísticas (DOM puro fora do container) seguem testáveis.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
