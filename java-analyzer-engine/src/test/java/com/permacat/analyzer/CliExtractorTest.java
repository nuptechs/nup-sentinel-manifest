package com.permacat.analyzer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-0023 O5 — trava o contrato byte-a-byte do modo CLI (o ex-Engine B do
 * codelens): as saídas esperadas abaixo foram CAPTURADAS do jar original
 * `java-parser-cli.jar` — se este teste quebrar, a paridade quebrou.
 */
class CliExtractorTest {

    @TempDir
    Path tmp;

    private String runCli(String... args) throws Exception {
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            CliExtractor.main(args);
        } finally {
            System.setOut(original);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    @Test
    void entidadeJpaComLombokEAnotacoes_saiNoContratoExatoDoEngineB() throws Exception {
        Path f = tmp.resolve("Conta.java");
        Files.writeString(f, """
                package com.exemplo;

                import jakarta.persistence.Entity;
                import jakarta.persistence.Id;
                import lombok.Getter;

                @Entity
                @Getter
                public class Conta extends Base implements Auditavel {
                    @Id
                    private Long id;
                    @Column(name = "valor_total", nullable = false)
                    private java.math.BigDecimal valor;
                }
                """);
        String out = runCli(f.toString());
        String expected = "{\"files\":[{\"path\":\"" + f + "\",\"package\":\"com.exemplo\","
                + "\"classes\":[{\"name\":\"Conta\",\"isInterface\":false,"
                + "\"annotations\":[{\"name\":\"Entity\"},{\"name\":\"Getter\"}],"
                + "\"extends\":[\"Base\"],\"implements\":[\"Auditavel\"],"
                + "\"fields\":[{\"annotations\":[{\"name\":\"Id\"}],\"names\":[\"id\"],\"type\":\"Long\",\"modifiers\":[\"private\"]},"
                + "{\"annotations\":[{\"name\":\"Column\",\"members\":{\"name\":\"\\\"valor_total\\\"\",\"nullable\":\"false\"}}],"
                + "\"names\":[\"valor\"],\"type\":\"java.math.BigDecimal\",\"modifiers\":[\"private\"]}],"
                + "\"methods\":[]}],\"enums\":[]}]}";
        assertEquals(expected, out);
    }

    @Test
    void enumEArquivoQuebrado_erroPorArquivoNuncaDerrubaOTodo() throws Exception {
        Path ok = tmp.resolve("Status.java");
        Files.writeString(ok, "package x; public enum Status { ATIVO, INATIVO }\n");
        Path broken = tmp.resolve("Broken.java");
        Files.writeString(broken, "public class {{{\n");
        String out = runCli(ok.toString(), broken.toString());
        assertTrue(out.contains("\"values\":[\"ATIVO\",\"INATIVO\"]"), out);
        assertTrue(out.contains("\"errors\":["), out);
        // O arquivo quebrado NÃO tem package/classes — só path+errors (contrato).
        assertTrue(out.contains("{\"path\":\"" + broken + "\",\"errors\":["), out);
    }

    @Test
    void launcherDespachaExtractProCli() throws Exception {
        Path f = tmp.resolve("Micro.java");
        Files.writeString(f, "package y; public class Micro {}\n");
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            Launcher.main(new String[] { "extract", f.toString() });
        } finally {
            System.setOut(original);
        }
        String out = captured.toString(StandardCharsets.UTF_8);
        assertTrue(out.startsWith("{\"files\":[{\"path\":"), out);
        assertTrue(out.contains("\"name\":\"Micro\""), out);
    }
}
