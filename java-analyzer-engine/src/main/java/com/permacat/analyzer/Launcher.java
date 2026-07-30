package com.permacat.analyzer;

import java.io.IOException;
import java.util.Arrays;

/**
 * ADR-0023 O5 (nup-sentinel) — entrypoint ÚNICO do engine Java consolidado.
 *
 * Dual-entrypoint por dispatch de argumento:
 *   java -jar java-analyzer-engine.jar extract <file_or_dir> ...
 *       → modo CLI ({@link CliExtractor} — o contrato do ex-Engine B do
 *         codelens: JSON {"files":[...]} em stdout, byte-a-byte)
 *   java -jar java-analyzer-engine.jar [porta]
 *       → modo HTTP ({@link AnalyzerServer} — o servidor de grafo que o
 *         backend-java-client do manifest spawna; args passam INTACTOS,
 *         preservando a convenção "args[0] = porta")
 *
 * "extract" não é numérico, então não colide com a convenção de porta do
 * servidor — o dispatch é inequívoco.
 */
public final class Launcher {

    private Launcher() {}

    public static void main(String[] args) throws IOException {
        if (args.length > 0 && "extract".equals(args[0])) {
            CliExtractor.main(Arrays.copyOfRange(args, 1, args.length));
            return;
        }
        AnalyzerServer.main(args);
    }
}
