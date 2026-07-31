package com.permacat.analyzer;

import com.permacat.model.AnalysisResult;
import com.permacat.model.GraphEdgeDTO;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Wave 2 — resolução interface→impl (padrão de registro/estratégia via DI).
 * Prova que uma chamada polimórfica (`executor.execute()` sobre um
 * `List<ActionExecutor>` injetado) liga a TODAS as impls concretas do projeto,
 * matando a ilha de executores/validadores/analyzers isolados; e que uma
 * chamada a classe CONCRETA segue com exatamente 1 aresta (sem regressão).
 */
class InterfaceImplResolutionTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    private static List<GraphEdgeDTO> callsFrom(AnalysisResult r, String fromSubstr) {
        return r.edges.stream()
            .filter(e -> "CALLS".equals(e.relationType) && e.fromNode.contains(fromSubstr))
            .toList();
    }

    @Test
    void chamadaPolimorficaLigaATodasAsImpls() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/ActionExecutor.java",
                "package t;\npublic interface ActionExecutor { void execute(); }\n",
            "t/MoveExec.java",
                "package t;\nimport org.springframework.stereotype.Component;\n@Component\npublic class MoveExec implements ActionExecutor { public void execute() {} }\n",
            "t/AssignExec.java",
                "package t;\nimport org.springframework.stereotype.Component;\n@Component\npublic class AssignExec implements ActionExecutor { public void execute() {} }\n",
            "t/RuleEngine.java",
                "package t;\nimport org.springframework.stereotype.Service;\nimport java.util.List;\n@Service\npublic class RuleEngine {\n private final List<ActionExecutor> execs;\n public RuleEngine(List<ActionExecutor> execs) { this.execs = execs; }\n public void run() { for (ActionExecutor e : execs) { e.execute(); } }\n}\n"
        ));

        List<GraphEdgeDTO> fromRun = callsFrom(r, "RuleEngine.run");
        // liga às DUAS impls concretas
        assertTrue(fromRun.stream().anyMatch(e -> e.toNode.contains("MoveExec.execute")),
            "deveria ligar a MoveExec.execute; arestas=" + fromRun.stream().map(e -> e.toNode).toList());
        assertTrue(fromRun.stream().anyMatch(e -> e.toNode.contains("AssignExec.execute")),
            "deveria ligar a AssignExec.execute");
        // arestas de fan-out marcadas honestamente
        assertTrue(fromRun.stream()
                .filter(e -> e.toNode.contains("Exec.execute"))
                .allMatch(e -> "interface-impl".equals(e.metadata.get("resolution"))
                        && "ActionExecutor".equals(e.metadata.get("via"))),
            "arestas de fan-out devem ter metadata resolution=interface-impl + via=ActionExecutor");
        // a interface em si NÃO é nó → nunca vira alvo
        assertTrue(r.nodes.stream().noneMatch(n -> n.id.contains(":t.ActionExecutor")),
            "interface sem stereotype não deve ser nó");
        assertFalse(fromRun.stream().anyMatch(e -> e.toNode.contains(".ActionExecutor.")),
            "não deve ligar ao método da interface (só às impls)");
    }

    @Test
    void chamadaConcretaSegueComUmaArestaSemMetadataDeFanout() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Helper.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Helper { public void doIt() {} }\n",
            "t/Caller.java",
                "package t;\nimport org.springframework.stereotype.Service;\nimport jakarta.inject.Inject;\n@Service\npublic class Caller {\n @Inject private Helper helper;\n public void m() { helper.doIt(); }\n}\n"
        ));

        List<GraphEdgeDTO> toDoIt = callsFrom(r, "Caller.m").stream()
            .filter(e -> e.toNode.contains("Helper.doIt")).toList();
        assertEquals(1, toDoIt.size(), "chamada concreta = exatamente 1 aresta");
        assertNull(toDoIt.get(0).metadata.get("resolution"),
            "chamada concreta não deve carregar metadata de fan-out (sem regressão)");
    }

    @Test
    void interfaceSemImplNaoQuebraNemInventaAresta() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Port.java",
                "package t;\npublic interface Port { void go(); }\n",
            "t/UsesPort.java",
                "package t;\nimport org.springframework.stereotype.Service;\nimport jakarta.inject.Inject;\n@Service\npublic class UsesPort {\n @Inject private Port port;\n public void run() { port.go(); }\n}\n"
        ));
        // sem impl no projeto → nenhuma aresta de código pra Port (não inventa)
        assertTrue(callsFrom(r, "UsesPort.run").stream().noneMatch(e -> e.toNode.contains("Port")),
            "sem impl no payload, não deve fabricar aresta");
        assertNotNull(r); // não lança
    }
}
