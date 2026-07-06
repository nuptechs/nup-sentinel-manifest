// ─────────────────────────────────────────────
// analysis-guard — unit tests (ADR-0014 D0)
//
// Each analysis route spawns a ~2 GB JVM. The guard bounds concurrency:
// at most 1 in-flight per project, MAX_GLOBAL per instance. Over the cap
// → 429, no JVM launched. Slots release on response finish/close.
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { analysisConcurrencyGuard, __resetAnalysisGuard } from "../../server/middleware/analysis-guard.ts";

function makeReq(params: any = {}) {
  return { params };
}

/** A fake res that records status and lets the test fire finish/close. */
function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    once(event: string, cb: () => void) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
    emit(event: string) {
      (listeners[event] || []).forEach((cb) => cb());
    },
  };
  return res;
}

function admit(guard: any, req: any, res: any): boolean {
  let nexted = false;
  guard(req, res, () => {
    nexted = true;
  });
  return nexted;
}

beforeEach(() => __resetAnalysisGuard());

describe("analysisConcurrencyGuard", () => {
  it("admits the first analysis for a project", () => {
    const guard = analysisConcurrencyGuard();
    const res = makeRes();
    assert.equal(admit(guard, makeReq({ id: "1" }), res), true);
  });

  it("429s a second concurrent analysis for the SAME project", () => {
    const guard = analysisConcurrencyGuard();
    const first = makeRes();
    admit(guard, makeReq({ id: "1" }), first); // holds the slot

    const second = makeRes();
    const nexted = admit(guard, makeReq({ id: "1" }), second);
    assert.equal(nexted, false);
    assert.equal(second.statusCode, 429);
    assert.equal(second.headers["Retry-After"], "30");
  });

  it("releases the slot on response finish, allowing a re-run", () => {
    const guard = analysisConcurrencyGuard();
    const first = makeRes();
    admit(guard, makeReq({ id: "1" }), first);
    first.emit("finish"); // analysis completed

    const again = makeRes();
    assert.equal(admit(guard, makeReq({ id: "1" }), again), true);
  });

  it("enforces the global cap across different projects", () => {
    // Default MAX_GLOBAL = 2.
    const guard = analysisConcurrencyGuard();
    admit(guard, makeReq({ id: "1" }), makeRes());
    admit(guard, makeReq({ id: "2" }), makeRes());

    const third = makeRes();
    const nexted = admit(guard, makeReq({ id: "3" }), third);
    assert.equal(nexted, false);
    assert.equal(third.statusCode, 429);
  });

  it("does not double-release when both finish and close fire", () => {
    const guard = analysisConcurrencyGuard();
    const res = makeRes();
    admit(guard, makeReq({ id: "1" }), res);
    res.emit("finish");
    res.emit("close"); // must be a no-op, not a negative counter

    // Two fresh admits should fit under the global cap of 2.
    assert.equal(admit(guard, makeReq({ id: "a" }), makeRes()), true);
    assert.equal(admit(guard, makeReq({ id: "b" }), makeRes()), true);
    const over = makeRes();
    assert.equal(admit(guard, makeReq({ id: "c" }), over), false);
    assert.equal(over.statusCode, 429);
  });
});
