import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRuleDispatch,
  parseRuleActionTypeEnum,
  renderRuleDispatchMarkdown,
} from "../../server/analyzers/rule-dispatch.ts";

const executor = (cls: string, actionType: string) => ({
  filePath: `src/main/java/easynup/services/common/rules/actions/${cls}.java`,
  content: `public class ${cls} implements ActionExecutor {\n  @Override\n  public RuleActionType getActionType() {\n    return RuleActionType.${actionType};\n  }\n  public ActionResult execute(RuleAction a, RuleContext c) { return null; }\n}`,
});

const enumFile = (values: string[]) => ({
  filePath: "src/main/java/easynup/persistence/enums/RuleActionType.java",
  content: `public enum RuleActionType {\n  ${values.map((v, i) => `${v}(${i})`).join(",\n  ")};\n  private final int code;\n  RuleActionType(int c){this.code=c;}\n}`,
});

describe("parseRuleActionTypeEnum", () => {
  it("extrai constantes do enum (com código)", () => {
    const vals = parseRuleActionTypeEnum([enumFile(["SEND_EMAIL", "SEND_PDF", "MOVE_STATUS"])]);
    assert.deepEqual(vals.sort(), ["MOVE_STATUS", "SEND_EMAIL", "SEND_PDF"]);
  });
  it("não vaza identificadores do corpo após o ;", () => {
    const vals = parseRuleActionTypeEnum([enumFile(["SEND_EMAIL"])]);
    assert.deepEqual(vals, ["SEND_EMAIL"]); // não pega 'RuleActionType' nem nada após ;
  });
});

describe("resolveRuleDispatch", () => {
  it("mapeia RuleActionType → executor via getActionType (o ponto cego do dispatch)", () => {
    const r = resolveRuleDispatch([
      executor("SendEmailActionExecutor", "SEND_EMAIL"),
      executor("SendPdfActionExecutor", "SEND_PDF"),
      enumFile(["SEND_EMAIL", "SEND_PDF"]),
    ]);
    assert.equal(r.summary.mapped, 2);
    assert.equal(r.summary.executors, 2);
    const pdf = r.dispatch.find((d) => d.actionType === "SEND_PDF")!;
    assert.equal(pdf.executor, "SendPdfActionExecutor");
    assert.ok(pdf.line > 0);
  });

  it("ignora a interface ActionExecutor e classes que não implementam", () => {
    const r = resolveRuleDispatch([
      { filePath: "x/ActionExecutor.java", content: "public interface ActionExecutor { RuleActionType getActionType(); }" },
      { filePath: "x/SomeHelper.java", content: "public class SomeHelper { void f(){} }" },
      executor("FlagAuditActionExecutor", "FLAG_AUDIT"),
    ]);
    assert.equal(r.summary.mapped, 1);
    assert.equal(r.dispatch[0].executor, "FlagAuditActionExecutor");
  });

  it("flagga tipo de ação DECLARADO sem executor (enum órfão)", () => {
    const r = resolveRuleDispatch([
      executor("SendEmailActionExecutor", "SEND_EMAIL"),
      enumFile(["SEND_EMAIL", "CALCULATE_DEDUCTION"]), // removido o executor de deduction
    ]);
    assert.deepEqual(r.unmappedActionTypes, ["CALCULATE_DEDUCTION"]);
    assert.equal(r.summary.unmapped, 1);
  });

  it("vazio≠falhou e null-safe", () => {
    assert.deepEqual(resolveRuleDispatch([]).dispatch, []);
    assert.equal(resolveRuleDispatch(null as any).summary.mapped, 0);
  });
});

describe("renderRuleDispatchMarkdown", () => {
  it("rende mapa + órfãos", () => {
    const r = resolveRuleDispatch([executor("SendPdfActionExecutor", "SEND_PDF"), enumFile(["SEND_PDF", "X_ORPHAN"])]);
    const md = renderRuleDispatchMarkdown(r, { projectName: "easynup" });
    assert.match(md, /Dispatch do Motor de Regras — easynup/);
    assert.match(md, /SEND_PDF.*SendPdfActionExecutor/);
    assert.match(md, /sem executor/);
    assert.match(md, /X_ORPHAN/);
  });
});
