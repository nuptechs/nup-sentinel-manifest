package com.permacat.analyzer;

import com.permacat.model.AnalysisResult;
import com.permacat.model.GraphNodeDTO;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * @Table(name="...") explícito → metadata.tableName no nó ENTITY. Fecha o furo
 * admitido em blind-impact.ts: entidade com nome de tabela divergente da
 * convenção snake_case(classe) aparecia como falso ponto cego no BIMR.
 */
class EntityTableNameTest {

    private static Map<String, String> files(String... pairs) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    private static GraphNodeDTO entity(AnalysisResult r, String simpleName) {
        return r.nodes.stream()
            .filter(n -> "ENTITY".equals(n.type) && n.id.contains(simpleName))
            .findFirst().orElseThrow();
    }

    @Test
    void tableNameDivergenteDaConvencaoEmitidoNoMetadata() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/LegacyUser.java",
            "package t;\nimport jakarta.persistence.Entity;\nimport jakarta.persistence.Table;\n" +
                "@Entity\n@Table(name = \"TB_USUARIO_LEGADO\")\npublic class LegacyUser { private String name; }\n"
        ));
        assertEquals("TB_USUARIO_LEGADO", entity(r, "LegacyUser").metadata.get("tableName"),
            "@Table(name=) divergente da convenção vira metadata.tableName");
    }

    @Test
    void variantesJavaxEQualificadaTambemExtraem() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/OldOrder.java",
            "package t;\nimport javax.persistence.Entity;\nimport javax.persistence.Table;\n" +
                "@Entity\n@Table(name = \"pedidos\", schema = \"legado\")\npublic class OldOrder { }\n",
            "t/Invoice.java",
            "package t;\nimport jakarta.persistence.Entity;\n@Entity\n@jakarta.persistence.Table(name = \"nota_fiscal\")\npublic class Invoice { }\n"
        ));
        assertEquals("pedidos", entity(r, "OldOrder").metadata.get("tableName"),
            "javax + schema= no meio não atrapalha o name=");
        assertEquals("nota_fiscal", entity(r, "Invoice").metadata.get("tableName"),
            "anotação totalmente qualificada também extrai");
    }

    @Test
    void semNameOuSemTableNaoEmite() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Contract.java",
            "package t;\nimport jakarta.persistence.Entity;\nimport jakarta.persistence.Table;\n" +
                "@Entity\n@Table(schema = \"core\")\npublic class Contract { }\n",
            "t/Simple.java",
            "package t;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Simple { }\n"
        ));
        assertNull(entity(r, "Contract").metadata.get("tableName"),
            "@Table sem name= fica na convenção (sem metadata)");
        assertNull(entity(r, "Simple").metadata.get("tableName"),
            "entidade sem @Table fica na convenção (sem metadata)");
    }

    @Test
    void nameViaConstanteNaoResolveFicaNaConvencao() {
        AnalysisResult r = new JavaASTAnalyzer().analyze(files(
            "t/Dyn.java",
            "package t;\nimport jakarta.persistence.Entity;\nimport jakarta.persistence.Table;\n" +
                "@Entity\n@Table(name = Dyn.TN)\npublic class Dyn { public static final String TN = \"x\"; }\n"
        ));
        assertNull(entity(r, "Dyn").metadata.get("tableName"),
            "name= por constante/expressão não é literal — não emite (conservador)");
    }
}
