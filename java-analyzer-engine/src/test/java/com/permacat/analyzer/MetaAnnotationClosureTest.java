package com.permacat.analyzer;

import com.permacat.model.AnalysisResult;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ADR-0025 Onda 5 — fecho transitivo de meta-anotações (estereótipos custom).
 * Park-first: repo com @DomainService (meta-anotado @Service) entra no mapa
 * sem mudança de engine; anotação de jar externo não classifica (conservador).
 */
class MetaAnnotationClosureTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    @Test
    void estereotipoCustomClassificaViaFecho() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/DomainService.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic @interface DomainService { }\n",
            "t/GlosaCalculator.java",
                "package t;\n@DomainService\npublic class GlosaCalculator {\n public void calcula() { }\n}\n"
        ));
        assertTrue(r.nodes.stream().anyMatch(n -> "SERVICE".equals(n.type) && n.id.contains("GlosaCalculator")),
            "classe com estereótipo custom vira nó SERVICE via fecho");
    }

    @Test
    void fechoTransitivoDoisNiveisECicloNaoTrava() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/A.java", "package t;\n@B\npublic @interface A { }\n",
            "t/B.java", "package t;\nimport org.springframework.stereotype.Component;\n@Component\n@A\npublic @interface B { }\n", // ciclo A↔B
            "t/Worker.java", "package t;\n@A\npublic class Worker {\n public void faz() { }\n}\n"
        ));
        assertTrue(r.nodes.stream().anyMatch(n -> "SERVICE".equals(n.type) && n.id.contains("Worker")),
            "fecho 2 níveis (com ciclo A↔B) classifica sem travar");
    }

    @Test
    void anotacaoDeJarExternoNaoClassifica() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Helper.java",
                "package t;\nimport lib.externa.Gerenciado;\n@Gerenciado\npublic class Helper {\n public void faz() { }\n}\n"
        ));
        assertFalse(r.nodes.stream().anyMatch(n -> n.id.contains("Helper")),
            "anotação sem declaração no payload não classifica (sem regressão/sem chute)");
    }

    @Test
    void classeJaClassificadaNaoMuda() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Marca.java",
                "package t;\nimport org.springframework.stereotype.Service;\n@Service\npublic @interface Marca { }\n",
            "t/Repo.java",
                "package t;\nimport org.springframework.stereotype.Repository;\n@Repository\n@Marca\npublic class Repo {\n public void faz() { }\n}\n"
        ));
        // @Repository direto vence; a marca custom de service não rebaixa/duplica
        assertTrue(r.nodes.stream().anyMatch(n -> "REPOSITORY".equals(n.type) && n.className.equals("Repo")),
            "classificação direta preservada");
        assertFalse(r.nodes.stream().anyMatch(n -> "SERVICE".equals(n.type) && n.className.equals("Repo")),
            "não vira SERVICE também");
    }
}
