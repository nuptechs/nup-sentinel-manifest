package com.permacat.analyzer;

import com.permacat.model.AnalysisResult;
import com.permacat.model.GraphEdgeDTO;
import com.permacat.model.GraphNodeDTO;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ADR-0026 EXT1 — herança como aresta de 1ª classe (EXTENDS/IMPLEMENTS), com
 * mint de nó de supertipo/interface do próprio código e precisão (framework
 * como JpaRepository/Serializable NÃO liga).
 */
class InheritanceEdgesTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    private static List<GraphEdgeDTO> edgesOf(AnalysisResult r, String rel) {
        return r.edges.stream().filter(e -> rel.equals(e.relationType)).toList();
    }

    private static AnalysisResult sample() {
        return new JavaASTAnalyzer().analyze(files(
            "t/BaseEntity.java",
                "package t;\npublic abstract class BaseEntity { private Long id; }\n",
            "t/Auditable.java",
                "package t;\npublic interface Auditable { }\n",
            "t/Contract.java",
                "package t;\nimport jakarta.persistence.Entity;\nimport java.io.Serializable;\n@Entity\npublic class Contract extends BaseEntity implements Auditable, Serializable { private String name; }\n",
            "t/CustomContractRepo.java",
                "package t;\npublic interface CustomContractRepo { }\n",
            "t/ContractRepository.java",
                "package t;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface ContractRepository extends JpaRepository<Contract, Long>, CustomContractRepo { }\n"
        ));
    }

    @Test
    void entidadeExtendsSuperclasseDoCodigoMintaSupertypeEEmiteEdge() {
        AnalysisResult r = sample();
        List<GraphEdgeDTO> ext = edgesOf(r, "EXTENDS");
        assertTrue(ext.stream().anyMatch(e ->
                e.fromNode.startsWith("ENTITY:") && e.fromNode.contains("Contract")
                    && e.toNode.startsWith("SUPERTYPE:") && e.toNode.contains("BaseEntity")
                    && "syntactic-declared".equals(e.metadata.get("resolution"))),
            "Contract EXTENDS BaseEntity (SUPERTYPE mintado); arestas=" + ext.stream().map(e -> e.fromNode + "->" + e.toNode).toList());
        GraphNodeDTO base = r.nodes.stream().filter(n -> n.id.startsWith("SUPERTYPE:") && n.id.contains("BaseEntity")).findFirst().orElseThrow();
        assertEquals(Boolean.TRUE, base.metadata.get("synthetic"), "supertipo mintado é synthetic");
    }

    @Test
    void entidadeImplementsInterfaceDoCodigoMintaInterfaceEEmiteEdge() {
        AnalysisResult r = sample();
        List<GraphEdgeDTO> impl = edgesOf(r, "IMPLEMENTS");
        assertTrue(impl.stream().anyMatch(e ->
                e.fromNode.contains("Contract") && e.toNode.startsWith("INTERFACE:") && e.toNode.contains("Auditable")),
            "Contract IMPLEMENTS Auditable (INTERFACE mintada); arestas=" + impl.stream().map(e -> e.fromNode + "->" + e.toNode).toList());
        assertTrue(r.nodes.stream().anyMatch(n -> n.id.startsWith("INTERFACE:") && n.id.contains("Auditable")),
            "nó INTERFACE Auditable mintado");
    }

    @Test
    void repositorioImplementaInterfaceCustomDoCodigo() {
        AnalysisResult r = sample();
        List<GraphEdgeDTO> impl = edgesOf(r, "IMPLEMENTS");
        assertTrue(impl.stream().anyMatch(e ->
                e.fromNode.startsWith("REPOSITORY:") && e.fromNode.contains("ContractRepository")
                    && e.toNode.startsWith("INTERFACE:") && e.toNode.contains("CustomContractRepo")),
            "ContractRepository IMPLEMENTS CustomContractRepo; arestas=" + impl.stream().map(e -> e.fromNode + "->" + e.toNode).toList());
    }

    @Test
    void tipoDeFrameworkNaoLiga_precisao() {
        AnalysisResult r = sample();
        assertFalse(r.edges.stream().anyMatch(e -> e.toNode.contains("JpaRepository")),
            "JpaRepository é framework — não liga (precisão)");
        assertFalse(r.edges.stream().anyMatch(e -> e.toNode.contains("Serializable")),
            "Serializable é framework — não liga (precisão)");
        assertFalse(r.nodes.stream().anyMatch(n -> n.id.contains("JpaRepository") || n.id.contains("Serializable")),
            "nenhum nó de tipo externo mintado");
    }
}
