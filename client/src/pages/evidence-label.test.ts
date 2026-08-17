import { describe, it, expect } from "vitest";
import { humanLabel } from "./evidence-label";

describe("humanLabel", () => {
  it("prefere className", () => {
    expect(humanLabel({ id: "x", className: "FooService", methodName: "bar" })).toBe("FooService");
  });
  it("nunca devolve o placeholder <module> — cai pro basename do arquivo", () => {
    expect(humanLabel({ id: "fn:server/foo.ts:<module>", methodName: "<module>", sourceFile: "server/analyzers/foo.ts" })).toBe("foo.ts");
  });
  it("sem className/method/sourceFile usáveis, cai pro fim do id (nunca <module>)", () => {
    const out = humanLabel({ id: "route:GET:/api/x", methodName: "<module>" });
    expect(out).toBe("x"); // último segmento do id por : ou /
    expect(out).not.toBe("<module>");
  });
  it("id terminando em <module> não vaza o placeholder", () => {
    // sem sourceFile e id cujo último segmento é <module> → devolve o id inteiro, nunca "<module>"
    const out = humanLabel({ id: "MODULE:<module>", methodName: "<module>" });
    expect(out).not.toBe("<module>");
  });
  it("methodName real é usado quando não há className", () => {
    expect(humanLabel({ id: "x", methodName: "handleRequest" })).toBe("handleRequest");
  });
  it("<anonymous> também é tratado como placeholder", () => {
    expect(humanLabel({ id: "y", methodName: "<anonymous>", sourceFile: "a/b/util.ts" })).toBe("util.ts");
  });
});
