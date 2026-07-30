package com.permacat.analyzer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ParserConfiguration.LanguageLevel;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.AnnotationMemberDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.expr.AnnotationExpr;

import java.io.IOException;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * ADR-0023 O5 (nup-sentinel) — modo CLI do ENGINE JAVA ÚNICO.
 *
 * Port FIEL do Main.java do java-parser-cli do codelens (Engine B, absorvido
 * nesta consolidação): mesmo contrato de I/O byte-a-byte — args = paths,
 * stdout = {"files":[...]} serializado com Jackson sobre LinkedHashMap
 * (ordem determinística), usage → exit 2, path inexistente → skip em stderr.
 * O symbol solver fica OFF DE PROPÓSITO (o contrato expõe tipos crus como
 * escritos; o modo HTTP/grafo usa o solver — caminhos independentes).
 *
 * CLI thin wrapper around JavaParser that extracts NuPtechs-relevant structures
 * (JPA entities, Spring controllers/services, security annotations, enums, DTOs)
 * from Java sources and emits JSON to stdout.
 *
 * Usage:
 *   java -jar java-parser-cli.jar &lt;file_or_dir&gt; [&lt;file_or_dir&gt; ...]
 *
 * Output: single JSON object with shape
 *   { "files": [ { "path": "...", "errors": [...], "classes": [...], "enums": [...] } ] }
 *
 * Symbol resolution is intentionally off in this MVP — enough to extract annotations,
 * field types as raw strings, and method signatures. Solver can be wired later if
 * cross-file type inference is required (with cache size tuning).
 */
public class CliExtractor {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static void main(String[] args) throws IOException {
        if (args.length == 0) {
            System.err.println("usage: java -jar java-analyzer-engine.jar extract <file_or_dir> ...");
            System.exit(2);
        }

        List<Path> files = new ArrayList<>();
        for (String arg : args) {
            Path p = Path.of(arg);
            if (!Files.exists(p)) {
                System.err.println("skip (not found): " + p);
                continue;
            }
            if (Files.isDirectory(p)) {
                Files.walk(p)
                        .filter(Files::isRegularFile)
                        .filter(x -> x.toString().endsWith(".java"))
                        .forEach(files::add);
            } else if (p.toString().endsWith(".java")) {
                files.add(p);
            }
        }

        ParserConfiguration config = new ParserConfiguration();
        // Java 21 LTS — covers switch expressions, records, pattern matching, sealed classes
        // used by EasyNuP. JAVA_21 is the highest enum value JavaParser 3.28 exposes.
        config.setLanguageLevel(LanguageLevel.JAVA_21);
        JavaParser parser = new JavaParser(config);
        Map<String, Object> output = new LinkedHashMap<>();
        List<Map<String, Object>> fileResults = new ArrayList<>();

        for (Path file : files) {
            fileResults.add(extractFile(parser, file));
        }

        output.put("files", fileResults);

        try (PrintWriter out = new PrintWriter(System.out)) {
            MAPPER.writeValue(out, output);
        }
    }

    private static Map<String, Object> extractFile(JavaParser parser, Path file) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("path", file.toString());

        ParseResult<CompilationUnit> parsed;
        try {
            parsed = parser.parse(file);
        } catch (IOException e) {
            result.put("errors", List.of("io: " + e.getMessage()));
            return result;
        }

        if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
            List<String> errors = new ArrayList<>();
            parsed.getProblems().forEach(p -> errors.add(p.getMessage()));
            result.put("errors", errors);
            return result;
        }

        CompilationUnit cu = parsed.getResult().get();

        result.put("package", cu.getPackageDeclaration()
                .map(pd -> pd.getNameAsString()).orElse(""));

        List<Map<String, Object>> classes = new ArrayList<>();
        cu.findAll(ClassOrInterfaceDeclaration.class).forEach(cls -> classes.add(extractClass(cls)));
        result.put("classes", classes);

        List<Map<String, Object>> enums = new ArrayList<>();
        cu.findAll(EnumDeclaration.class).forEach(e -> enums.add(extractEnum(e)));
        result.put("enums", enums);

        return result;
    }

    private static Map<String, Object> extractClass(ClassOrInterfaceDeclaration cls) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("name", cls.getNameAsString());
        data.put("isInterface", cls.isInterface());
        data.put("annotations", extractAnnotations(cls.getAnnotations()));

        List<String> extending = new ArrayList<>();
        cls.getExtendedTypes().forEach(t -> extending.add(t.getNameAsString()));
        data.put("extends", extending);

        List<String> implementing = new ArrayList<>();
        cls.getImplementedTypes().forEach(t -> implementing.add(t.getNameAsString()));
        data.put("implements", implementing);

        List<Map<String, Object>> fields = new ArrayList<>();
        cls.getFields().forEach(f -> fields.add(extractField(f)));
        data.put("fields", fields);

        List<Map<String, Object>> methods = new ArrayList<>();
        cls.getMethods().forEach(m -> methods.add(extractMethod(m)));
        data.put("methods", methods);

        return data;
    }

    private static Map<String, Object> extractField(FieldDeclaration field) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("annotations", extractAnnotations(field.getAnnotations()));

        List<String> names = new ArrayList<>();
        field.getVariables().forEach(v -> names.add(v.getNameAsString()));
        data.put("names", names);

        data.put("type", field.getElementType().asString());
        data.put("modifiers", field.getModifiers().stream()
                .map(m -> m.getKeyword().asString()).toList());
        return data;
    }

    private static Map<String, Object> extractMethod(MethodDeclaration method) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("name", method.getNameAsString());
        data.put("annotations", extractAnnotations(method.getAnnotations()));
        data.put("returnType", method.getType().asString());
        data.put("modifiers", method.getModifiers().stream()
                .map(m -> m.getKeyword().asString()).toList());

        List<Map<String, Object>> params = new ArrayList<>();
        for (Parameter p : method.getParameters()) {
            Map<String, Object> param = new LinkedHashMap<>();
            param.put("name", p.getNameAsString());
            param.put("type", p.getType().asString());
            param.put("annotations", extractAnnotations(p.getAnnotations()));
            params.add(param);
        }
        data.put("parameters", params);
        return data;
    }

    private static Map<String, Object> extractEnum(EnumDeclaration en) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("name", en.getNameAsString());
        data.put("annotations", extractAnnotations(en.getAnnotations()));
        List<String> values = new ArrayList<>();
        en.getEntries().forEach(e -> values.add(e.getNameAsString()));
        data.put("values", values);
        return data;
    }

    private static List<Map<String, Object>> extractAnnotations(Iterable<AnnotationExpr> annotations) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (AnnotationExpr ann : annotations) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("name", ann.getNameAsString());
            // Raw arguments as string (covers single-member, normal, and marker forms).
            // Consumers parse semantically — keeping JSON small here.
            if (ann.isSingleMemberAnnotationExpr()) {
                data.put("value", ann.asSingleMemberAnnotationExpr().getMemberValue().toString());
            } else if (ann.isNormalAnnotationExpr()) {
                Map<String, String> members = new LinkedHashMap<>();
                ann.asNormalAnnotationExpr().getPairs().forEach(pair ->
                        members.put(pair.getNameAsString(), pair.getValue().toString()));
                data.put("members", members);
            }
            result.add(data);
        }
        return result;
    }
}
