import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveEventWiring, renderEventWiringMarkdown } from "../../server/analyzers/event-wiring.ts";

const f = (filePath: string, content: string) => ({ filePath, content });

// Espelha as formas reais achadas na sondagem do easynup.
const slaListener = f(
  "src/main/java/easynup/services/common/listeners/SlaMeasurementApprovedListener.java",
  `public class SlaMeasurementApprovedListener {
  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void onMeasurementApproved(RuleEvent event) {
    if (event.getTriggerType() != RuleTriggerType.MEASUREMENT_APPROVED) return;
    if (event.getEntityType() != RuleEntityType.SLA_MEASUREMENT) return;
    // ...
  }
}`,
);

const balanceListener = f(
  "src/main/java/easynup/services/common/components/ContractBalanceEventListener.java",
  `public class ContractBalanceEventListener {
  @TransactionalEventListener
  public void handleServiceOrderStatusChange(RuleEvent event) {
    if (event.getEntityType() != RuleEntityType.SERVICE_ORDER) return;
    if (!"STATUS_CHANGED".equals(event.getTriggerType().name())) return;
  }
}`,
);

const catchAllListener = f(
  "src/main/java/easynup/services/common/rules/triggers/RuleEventListener.java",
  `public class RuleEventListener {
  @TransactionalEventListener
  public void handleRuleEvent(RuleEvent event) {
    ruleEngine.evaluate(toContext(event));
  }
}`,
);

const publisher = f(
  "src/main/java/easynup/services/common/rules/triggers/RuleEventPublisher.java",
  `public class RuleEventPublisher {
  public void publishMeasurementApproved(Long id) {
    RuleEvent event = RuleEvent.builder().triggerType(RuleTriggerType.MEASUREMENT_APPROVED).build();
    eventPublisher.publishEvent(event);
  }
  public void publishStatusChanged(RuleEntityType entityType, Long id) {
    RuleEvent event = RuleEvent.builder().triggerType(RuleTriggerType.STATUS_CHANGED).build();
    eventPublisher.publishEvent(event);
  }
}`,
);

describe("resolveEventWiring — listeners", () => {
  it("extrai guard triggerType + entityType (forma enum)", () => {
    const r = resolveEventWiring([slaListener]);
    const l = r.listeners.find((x) => x.method === "onMeasurementApproved")!;
    assert.equal(l.eventType, "RuleEvent");
    assert.equal(l.triggerType, "MEASUREMENT_APPROVED");
    assert.equal(l.entityType, "SLA_MEASUREMENT");
    assert.equal(l.routing, "guarded");
  });

  it("extrai guard na forma string \"X\".equals(getTriggerType().name())", () => {
    const r = resolveEventWiring([balanceListener]);
    const l = r.listeners[0];
    assert.equal(l.triggerType, "STATUS_CHANGED");
    assert.equal(l.entityType, "SERVICE_ORDER");
    assert.equal(l.routing, "guarded");
  });

  it("listener SEM guard estático → routing dynamic (não inventa destino)", () => {
    const r = resolveEventWiring([catchAllListener]);
    const l = r.listeners[0];
    assert.equal(l.triggerType, null);
    assert.equal(l.routing, "dynamic");
  });

  it("ignora ApplicationReadyEvent (scheduler boot, não evento de domínio)", () => {
    const r = resolveEventWiring([
      f("x/Sched.java", `public class Sched {\n  @EventListener\n  public void onReady(ApplicationReadyEvent e) {}\n}`),
    ]);
    assert.equal(r.listeners.length, 0);
  });
});

describe("resolveEventWiring — publishers", () => {
  it("mapeia método publisher → triggerType emitido", () => {
    const r = resolveEventWiring([publisher]);
    assert.equal(r.summary.triggerTypesEmitted, 2);
    const ma = r.publishers.find((p) => p.triggerType === "MEASUREMENT_APPROVED")!;
    assert.equal(ma.method, "publishMeasurementApproved");
    const sc = r.publishers.find((p) => p.triggerType === "STATUS_CHANGED")!;
    assert.equal(sc.method, "publishStatusChanged");
  });
});

describe("resolveEventWiring — robustez", () => {
  it("vazio≠falhou e null-safe", () => {
    assert.deepEqual(resolveEventWiring([]).listeners, []);
    assert.equal(resolveEventWiring(null as any).summary.listeners, 0);
  });

  it("conecta as duas pontas: triggerType emitido casa com o guard do listener", () => {
    const r = resolveEventWiring([slaListener, publisher]);
    const emitted = new Set(r.publishers.map((p) => p.triggerType));
    const guard = r.listeners.find((l) => l.triggerType === "MEASUREMENT_APPROVED");
    assert.ok(guard, "listener guarda MEASUREMENT_APPROVED");
    assert.ok(emitted.has("MEASUREMENT_APPROVED"), "publisher emite MEASUREMENT_APPROVED");
  });
});

describe("renderEventWiringMarkdown", () => {
  it("marca catch-all e lista publishers", () => {
    const md = renderEventWiringMarkdown(resolveEventWiring([catchAllListener, publisher]), { projectName: "easynup" });
    assert.match(md, /Wiring de Eventos — easynup/);
    assert.match(md, /catch-all/);
    assert.match(md, /MEASUREMENT_APPROVED/);
  });
});
