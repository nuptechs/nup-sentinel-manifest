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
 * ADR-0025 Ondas 3+4+T1 — associações JPA (entidade-filha), JPQL
 * (@Query + em.createQuery) e entry-points (@Scheduled/runner), com
 * proveniência por aresta (T1).
 */
class AssociationsJpqlEntryPointTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    private static List<GraphEdgeDTO> edgesOf(AnalysisResult r, String rel) {
        return r.edges.stream().filter(e -> rel.equals(e.relationType)).toList();
    }

    @Test
    void associacaoJpaLigaPaiAFilhaComProveniencia() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/ReferenceTable.java",
                "package t;\nimport jakarta.persistence.*;\nimport java.util.List;\n@Entity\npublic class ReferenceTable {\n @OneToMany\n private List<ReferenceTableRow> rows;\n @ManyToOne\n private Owner owner;\n}\n",
            "t/ReferenceTableRow.java",
                "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class ReferenceTableRow { private String v; }\n",
            "t/Owner.java",
                "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Owner { private String name; }\n"
        ));
        List<GraphEdgeDTO> assoc = edgesOf(r, "ASSOCIATES");
        assertTrue(assoc.stream().anyMatch(e ->
                e.fromNode.contains("ReferenceTable") && !e.fromNode.contains("Row")
                    && e.toNode.contains("ReferenceTableRow")
                    && "OneToMany".equals(e.metadata.get("kind"))),
            "pai→filha via @OneToMany (genérico List<Filha>); arestas=" + assoc.stream().map(e -> e.fromNode + "->" + e.toNode).toList());
        assertTrue(assoc.stream().anyMatch(e ->
                e.toNode.contains("Owner") && "ManyToOne".equals(e.metadata.get("kind"))),
            "@ManyToOne pelo tipo declarado");
        assertTrue(assoc.stream().allMatch(e -> "syntactic-declared".equals(e.metadata.get("resolution"))),
            "T1: toda aresta ASSOCIATES com proveniência");
        // a FILHA deixou de ser isolada (tem grau > 0)
        GraphNodeDTO filha = r.nodes.stream().filter(n -> n.id.contains("ReferenceTableRow")).findFirst().orElseThrow();
        assertTrue(r.edges.stream().anyMatch(e -> filha.id.equals(e.toNode) || filha.id.equals(e.fromNode)),
            "entidade-filha conectada");
    }

    @Test
    void associacaoParaTipoNaoEntidadeNaoLiga() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Pai.java",
                "package t;\nimport jakarta.persistence.*;\nimport java.util.List;\n@Entity\npublic class Pai {\n @OneToMany\n private List<String> tags;\n}\n"
        ));
        assertEquals(0, edgesOf(r, "ASSOCIATES").size(), "List<String> não é entidade — não liga");
    }

    @Test
    void jpqlDeQueryNoRepositorioLigaEntidadesDoFromJoinUpdate() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/User.java", "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class User { }\n",
            "t/Payment.java", "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Payment { }\n",
            "t/UserRepo.java",
                "package t;\nimport org.springframework.data.jpa.repository.*;\npublic interface UserRepo extends JpaRepository<User, Long> {\n" +
                " @Query(\"select u from User u join Payment p on p.userId = u.id\")\n java.util.List<User> comPagamento();\n" +
                " @Query(\"update User u set u.active = false\")\n void desativaTodos();\n}\n"
        ));
        // FROM User → READS · join Payment (entity join capitalizado) → READS · update User → WRITES
        assertTrue(edgesOf(r, "READS_ENTITY").stream().anyMatch(e ->
                e.fromNode.startsWith("REPOSITORY:") && e.toNode.contains("Payment") && "jpql".equals(e.metadata.get("operation"))),
            "join de ENTIDADE no JPQL vira READS_ENTITY");
        assertTrue(edgesOf(r, "WRITES_ENTITY").stream().anyMatch(e ->
                e.fromNode.startsWith("REPOSITORY:") && e.toNode.contains("User") && "jpql".equals(e.metadata.get("operation"))),
            "update JPQL vira WRITES_ENTITY");
    }

    @Test
    void emCreateQueryNoServicoLigaMetodoAEntidade() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Consolidacao.java", "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Consolidacao { }\n",
            "t/RelatorioService.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic class RelatorioService {\n" +
                " public void gera() { em().createQuery(\"select c from Consolidacao c\").getResultList(); }\n" +
                " private Object em() { return null; }\n}\n"
        ));
        assertTrue(edgesOf(r, "READS_ENTITY").stream().anyMatch(e ->
                e.fromNode.contains("RelatorioService.gera") && e.toNode.contains("Consolidacao")
                    && "jpql".equals(e.metadata.get("operation"))),
            "em.createQuery no corpo liga método→entidade");
    }

    @Test
    void joinDeAssociacaoMinusculoNaoVinaEntidade() {
        JavaASTAnalyzer a = new JavaASTAnalyzer();
        JavaASTAnalyzer.JpqlFacts f = a.parseJpql("select u from User u join u.roles r join fetch u.perms p");
        assertEquals(List.of("User"), f.entities, "join u.roles (path de associação) fica fora");
        assertEquals("read", f.op);
        JavaASTAnalyzer.JpqlFacts w = a.parseJpql("delete from Sessao s where s.old = true");
        assertEquals("write", w.op);
        assertEquals(List.of("Sessao"), w.entities);
    }

    @Test
    void entryPointsMarcadosNoMetadata() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/AutoScheduler.java",
                "package t;\nimport org.springframework.stereotype.Service;\nimport org.springframework.scheduling.annotation.Scheduled;\n@Service\npublic class AutoScheduler {\n @Scheduled(cron = \"0 0 * * * *\")\n public void tick() { }\n}\n",
            "t/BootSeed.java",
                "package t;\nimport org.springframework.stereotype.Component;\nimport org.springframework.boot.CommandLineRunner;\n@Component\npublic class BootSeed implements CommandLineRunner {\n public void run(String... args) { }\n}\n",
            "t/Normal.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Normal {\n public void faz() { }\n}\n"
        ));
        GraphNodeDTO tick = r.nodes.stream().filter(n -> n.id.contains("AutoScheduler.tick")).findFirst().orElseThrow();
        assertEquals("Scheduled", tick.metadata.get("entryPoint"), "@Scheduled marcado");
        GraphNodeDTO run = r.nodes.stream().filter(n -> n.id.contains("BootSeed.run")).findFirst().orElseThrow();
        assertEquals("ApplicationRunner", run.metadata.get("entryPoint"), "runner marcado no run()");
        GraphNodeDTO normal = r.nodes.stream().filter(n -> n.id.contains("Normal.faz")).findFirst().orElseThrow();
        assertNull(normal.metadata.get("entryPoint"), "método comum sem marca (sem regressão)");
    }
}
