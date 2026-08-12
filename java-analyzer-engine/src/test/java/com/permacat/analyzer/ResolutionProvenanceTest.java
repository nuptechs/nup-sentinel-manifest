package com.permacat.analyzer;

import com.permacat.model.AnalysisResult;
import com.permacat.model.GraphEdgeDTO;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T1 (ADR-0025) — CONTRATO de proveniência produtor↔classificador.
 *
 * O classificador (server/analyzers/system-graph.ts, PRECISE_RESOLUTIONS) trata
 * `syntactic-resolved` como PRECISO (STATIC_PROVEN): significa que o
 * `callExpr.resolve()` do SymbolSolver SUCEDEU (resolução JLS sobre fonte do
 * projeto + JDK). `syntactic-declared` segue HEURÍSTICO (fallback ADR-0018 pelo
 * tipo declarado). Este teste pina o lado produtor desse contrato — se o valor
 * emitido mudar, o classificador do server precisa mudar JUNTO.
 */
class ResolutionProvenanceTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    private static AnalysisResult analyzeFixture() {
        return new JavaASTAnalyzer().analyze(files(
            "t/Contract.java",
                "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Contract { private Long id; }\n",
            "t/ContractRepo.java",
                "package t;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface ContractRepo extends JpaRepository<Contract, Long> { }\n",
            "t/Helper.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Helper { public void doIt() {} public void log(Object o) {} }\n",
            "t/ContractService.java",
                "package t;\nimport org.springframework.stereotype.Service;\nimport jakarta.inject.Inject;\nimport com.acme.ExternalThing;\n@Service\npublic class ContractService {\n @Inject private ContractRepo repo;\n @Inject private Helper helper;\n private ExternalThing thing;\n public void run(Contract c) { helper.doIt(); repo.save(c); }\n public void audit() { helper.log(thing); }\n}\n"
        ));
    }

    @Test
    void chamadaResolvidaPeloSolverEmiteSyntacticResolved() {
        AnalysisResult r = analyzeFixture();
        // helper.doIt(): Helper é fonte do projeto → resolve() sucede → PRECISO.
        List<GraphEdgeDTO> toDoIt = r.edges.stream()
            .filter(e -> "CALLS".equals(e.relationType)
                && e.fromNode.contains("ContractService.run")
                && e.toNode.contains("Helper.doIt"))
            .toList();
        assertEquals(1, toDoIt.size(), "esperava 1 aresta run→doIt; edges=" + r.edges);
        assertEquals("syntactic-resolved", toDoIt.get(0).metadata.get("resolution"),
            "chamada resolvida pelo SymbolSolver deve carimbar syntactic-resolved");
    }

    @Test
    void chamadaHerdadaDeSpringResolvePeloReflectionSolver() {
        AnalysisResult r = analyzeFixture();
        // repo.save(): herdado de JpaRepository — que o engine EMBARCA no
        // classpath (pom: spring-data-jpa) justamente p/ o ReflectionTypeSolver
        // resolver a hierarquia. Logo resolve() SUCEDE → PRECISO.
        List<GraphEdgeDTO> toSave = r.edges.stream()
            .filter(e -> "CALLS".equals(e.relationType)
                && e.fromNode.contains("ContractService.run")
                && e.toNode.contains("ContractRepo")
                && e.toNode.contains("save"))
            .toList();
        assertEquals(1, toSave.size(), "esperava 1 aresta run→repo.save; edges=" + r.edges);
        assertEquals("syntactic-resolved", toSave.get(0).metadata.get("resolution"),
            "save herdado do Spring embarcado resolve pelo solver");
    }

    @Test
    void solverFalhandoEmTipoExternoCaiNoFallbackDeclared() {
        AnalysisResult r = analyzeFixture();
        // helper.log(thing): o tipo do argumento (com.acme.ExternalThing) NÃO
        // existe no projeto nem no classpath do engine → resolve() FALHA →
        // fallback ADR-0018 liga pelo tipo DECLARADO do campo `helper`.
        List<GraphEdgeDTO> toLog = r.edges.stream()
            .filter(e -> "CALLS".equals(e.relationType)
                && e.fromNode.contains("ContractService.audit")
                && e.toNode.contains("Helper.log"))
            .toList();
        assertEquals(1, toLog.size(), "esperava 1 aresta audit→Helper.log; edges=" + r.edges);
        assertEquals("syntactic-declared", toLog.get(0).metadata.get("resolution"),
            "fallback sintático NÃO pode carimbar syntactic-resolved");
    }

    @Test
    void repoEntidadeViaGenericoResolvidoPeloSolverEmiteSyntacticResolved() {
        AnalysisResult r = analyzeFixture();
        // JpaRepository<Contract,·>: o ARGUMENTO genérico resolve pelo solver
        // (Contract é fonte do projeto) mesmo com JpaRepository externo.
        List<GraphEdgeDTO> repoToEntity = r.edges.stream()
            .filter(e -> "READS_ENTITY".equals(e.relationType)
                && e.fromNode.startsWith("REPOSITORY:")
                && e.fromNode.contains("ContractRepo")
                && !e.fromNode.contains("save")
                && e.toNode.contains("Contract"))
            .toList();
        assertFalse(repoToEntity.isEmpty(), "esperava aresta repo→entidade; edges=" + r.edges);
        assertEquals("syntactic-resolved", repoToEntity.get(0).metadata.get("resolution"),
            "genérico resolvido pelo solver deve carimbar syntactic-resolved");
    }
}
