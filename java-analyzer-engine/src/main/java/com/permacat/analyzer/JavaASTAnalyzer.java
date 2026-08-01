package com.permacat.analyzer;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.ast.visitor.VoidVisitorAdapter;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedReferenceTypeDeclaration;
import com.github.javaparser.resolution.types.ResolvedReferenceType;
import com.github.javaparser.resolution.types.ResolvedType;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import com.permacat.model.*;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Collectors;

public class JavaASTAnalyzer {

    private static final Set<String> CONTROLLER_ANNOTATIONS = Set.of(
        "RestController", "Controller"
    );
    private static final Set<String> SERVICE_ANNOTATIONS = Set.of(
        "Service", "Component"
    );
    private static final Set<String> REPOSITORY_ANNOTATIONS = Set.of(
        "Repository"
    );
    private static final Set<String> ENTITY_ANNOTATIONS = Set.of(
        "Entity", "Table", "Document"
    );
    private static final Set<String> MAPPING_ANNOTATIONS = Set.of(
        "RequestMapping", "GetMapping", "PostMapping", "PutMapping",
        "DeleteMapping", "PatchMapping"
    );
    private static final Set<String> SECURITY_ANNOTATIONS = Set.of(
        "PreAuthorize", "Secured", "RolesAllowed", "DenyAll", "PermitAll"
    );
    private static final Set<String> REPO_INTERFACES = Set.of(
        "JpaRepository", "CrudRepository", "PagingAndSortingRepository",
        "MongoRepository", "ReactiveCrudRepository", "Repository"
    );
    private static final Set<String> PERSISTENCE_SAVE = Set.of(
        "save", "saveAll", "saveAndFlush", "insert", "create", "persist", "merge", "update"
    );
    private static final Set<String> PERSISTENCE_DELETE = Set.of(
        "delete", "deleteById", "deleteAll", "deleteAllById", "remove", "removeById"
    );
    private static final Set<String> PERSISTENCE_READ = Set.of(
        "findById", "findAll", "findOne", "getById", "getReferenceById",
        "getOne", "existsById", "count", "findAllById"
    );
    // Onda 3a (ADR-0025): associações JPA no fonte da entidade → aresta ASSOCIATES
    private static final Set<String> ASSOCIATION_ANNOTATIONS = Set.of(
        "OneToMany", "ManyToOne", "OneToOne", "ManyToMany", "Embedded", "ElementCollection"
    );
    // Onda 4 (ADR-0025): gatilhos de fundo — roots legítimos, não "isolados"
    private static final Set<String> ENTRY_POINT_ANNOTATIONS = Set.of(
        "Scheduled", "EventListener", "TransactionalEventListener", "KafkaListener",
        "RabbitListener", "SqsListener", "JmsListener", "PostConstruct"
    );
    private static final Set<String> RUNNER_INTERFACES = Set.of(
        "CommandLineRunner", "ApplicationRunner"
    );

    private final SymbolMap symbolClassMap = new SymbolMap();
    private final Map<String, ClassInfo> fqnIndex = new HashMap<>();
    // Onda 5 (ADR-0025): @interface declaradas no payload → suas meta-anotações
    // (nomes simples). Base do fecho transitivo de estereótipos: um @DomainService
    // meta-anotado com @Service classifica a classe como SERVICE — o modelo do
    // Spring ("any annotation meta-annotated with @Component is a stereotype").
    private final Map<String, Set<String>> annotationMetas = new HashMap<>();
    // Wave 2 (interface→impl): nome SIMPLES de interface → impls do projeto que a
    // declaram (implements/extends). Resolve o padrão DI de registro/estratégia
    // — ex. RuleEngine injeta `List<ActionExecutor>` e chama `executor.execute()`:
    // o alvo é a INTERFACE, e sem esse índice todas as ~22 impls ficam isoladas.
    private final Map<String, List<ClassInfo>> implsBySimpleName = new HashMap<>();

    static class SymbolMap {
        private final Map<String, ClassInfo> byQualifiedName = new HashMap<>();

        void put(ResolvedReferenceTypeDeclaration symbol, ClassInfo info) {
            byQualifiedName.put(symbol.getQualifiedName(), info);
        }

        ClassInfo get(ResolvedReferenceTypeDeclaration symbol) {
            if (symbol == null) return null;
            return byQualifiedName.get(symbol.getQualifiedName());
        }
    }

    public AnalysisResult analyze(Map<String, String> files) {
        Path tempDir = null;
        List<String> resolutionErrors = new ArrayList<>();
        long totalStart = System.currentTimeMillis();
        try {
            long phaseStart = System.currentTimeMillis();
            tempDir = writeFilesToTemp(files);
            System.out.println("[java-engine] Phase 1/7: Write files to temp — " + (System.currentTimeMillis() - phaseStart) + "ms");

            phaseStart = System.currentTimeMillis();
            JavaParser parser = configureParserWithSymbolSolver(tempDir);
            System.out.println("[java-engine] Phase 2/7: Configure parser + symbol solver — " + (System.currentTimeMillis() - phaseStart) + "ms");

            phaseStart = System.currentTimeMillis();
            List<CompilationUnit> compilationUnits = new ArrayList<>();
            int parseErrors = 0;
            for (Map.Entry<String, String> entry : files.entrySet()) {
                String filePath = entry.getKey();
                String content = entry.getValue();
                try {
                    ParseResult<CompilationUnit> result = parser.parse(content);
                    if (result.isSuccessful() && result.getResult().isPresent()) {
                        CompilationUnit cu = result.getResult().get();
                        compilationUnits.add(cu);
                        extractClassInfo(cu, filePath);
                    } else {
                        parseErrors++;
                        String problems = result.getProblems().stream()
                            .map(p -> p.getMessage())
                            .collect(Collectors.joining("; "));
                        String msg = "Parse error in " + filePath + ": " + problems;
                        System.err.println(msg);
                        resolutionErrors.add(msg);
                    }
                } catch (Exception e) {
                    parseErrors++;
                    String msg = "Failed to parse " + filePath + ": " + e.getMessage();
                    System.err.println(msg);
                    resolutionErrors.add(msg);
                }
            }
            System.out.println("[java-engine] Phase 3/8: Parse " + files.size() + " files — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + compilationUnits.size() + " OK, " + parseErrors + " errors, " + fqnIndex.size() + " classes found)");

            phaseStart = System.currentTimeMillis();
            int reclassified = applyMetaAnnotationClosure();
            System.out.println("[java-engine] Phase 3.2/8: Meta-annotation closure — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + annotationMetas.size() + " @interface no payload, " + reclassified + " classes reclassificadas)");

            phaseStart = System.currentTimeMillis();
            resolveSuperclassBasePaths();
            long controllersFound = fqnIndex.values().stream().filter(ci -> ci.isController).count();
            System.out.println("[java-engine] Phase 3.5/8: Resolve superclass base paths — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + controllersFound + " controllers detected)");

            phaseStart = System.currentTimeMillis();
            resolveClassSymbols(compilationUnits, resolutionErrors);
            System.out.println("[java-engine] Phase 4/8: Resolve class symbols — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + symbolClassMap.byQualifiedName.size() + " resolved)");

            phaseStart = System.currentTimeMillis();
            resolveMethodSignatures(compilationUnits, resolutionErrors);
            long totalMethods = fqnIndex.values().stream().mapToLong(ci -> ci.methods.size()).sum();
            long resolvedMethods = fqnIndex.values().stream()
                .flatMap(ci -> ci.methods.stream())
                .filter(m -> m.resolvedQualifiedSignature != null).count();
            System.out.println("[java-engine] Phase 5/8: Resolve method signatures — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + resolvedMethods + "/" + totalMethods + " resolved)");

            phaseStart = System.currentTimeMillis();
            resolveRepositoryEntitiesViaGenerics(compilationUnits, resolutionErrors);
            long reposWithEntity = fqnIndex.values().stream()
                .filter(ci -> ci.isRepository && ci.resolvedEntityClassName != null).count();
            System.out.println("[java-engine] Phase 6/8: Resolve repository entities — " + (System.currentTimeMillis() - phaseStart) + "ms ("
                + reposWithEntity + " repos linked to entities)");

        } catch (Exception e) {
            System.err.println("Symbol solver init failed: " + e.getMessage());
            resolutionErrors.add("Symbol solver init failed: " + e.getMessage());
        } finally {
            if (tempDir != null) {
                deleteRecursively(tempDir.toFile());
            }
        }

        long phaseStart = System.currentTimeMillis();
        AnalysisResult result = buildGraph(resolutionErrors);
        System.out.println("[java-engine] Phase 8/8: Build graph — " + (System.currentTimeMillis() - phaseStart) + "ms");
        System.out.println("[java-engine] Total analysis time: " + ((System.currentTimeMillis() - totalStart) / 1000.0) + "s");
        return result;
    }

    /**
     * Onda 5 (ADR-0025): fecho transitivo de meta-anotações — o modelo real do
     * Spring ("any annotation meta-annotated with @Component is a stereotype",
     * javadoc do @Component). Classe anotada com @X, onde @X (declarada no
     * payload) é meta-anotada — direta ou transitivamente — com um estereótipo
     * conhecido, é classificada como se tivesse o estereótipo. BFS com visited
     * (ciclo de meta-anotação não trava). Só ADICIONA classificação (classe já
     * classificada fica como está — zero regressão). Anotação de fora do payload
     * (jar externo) não tem declaração aqui → sem efeito, conservador.
     */
    private int applyMetaAnnotationClosure() {
        if (annotationMetas.isEmpty()) return 0;
        int changed = 0;
        for (ClassInfo info : fqnIndex.values()) {
            if (info.classAnnotationNames == null || info.classAnnotationNames.isEmpty()) continue;
            // expande o fecho das anotações da classe
            Set<String> closure = new HashSet<>();
            Deque<String> queue = new ArrayDeque<>(info.classAnnotationNames);
            while (!queue.isEmpty()) {
                String ann = queue.poll();
                if (!closure.add(ann)) continue;
                Set<String> metas = annotationMetas.get(ann);
                if (metas != null) queue.addAll(metas);
            }
            boolean before = info.isService || info.isRepository || info.isEntity || info.isController;
            if (!info.isEntity && closure.stream().anyMatch(ENTITY_ANNOTATIONS::contains)) info.isEntity = true;
            if (!info.isRepository && closure.stream().anyMatch(REPOSITORY_ANNOTATIONS::contains)) info.isRepository = true;
            if (!info.isController && closure.stream().anyMatch(CONTROLLER_ANNOTATIONS::contains)) info.isController = true;
            if (!info.isService && !info.isEntity && !info.isRepository
                && closure.stream().anyMatch(SERVICE_ANNOTATIONS::contains)) info.isService = true;
            boolean after = info.isService || info.isRepository || info.isEntity || info.isController;
            if (!before && after) changed++;
        }
        return changed;
    }

    private void resolveClassSymbols(List<CompilationUnit> compilationUnits, List<String> resolutionErrors) {
        for (CompilationUnit cu : compilationUnits) {
            for (ClassOrInterfaceDeclaration cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String className = cls.getNameAsString();
                ClassInfo info = fqnIndex.values().stream()
                    .filter(ci -> ci.className.equals(className))
                    .findFirst().orElse(null);
                if (info == null) continue;

                try {
                    ResolvedReferenceTypeDeclaration resolved = cls.resolve();
                    info.resolvedSymbol = resolved;
                    symbolClassMap.put(resolved, info);
                } catch (Exception e) {
                    String msg = "Could not resolve class " + className + ": " + e.getMessage();
                    resolutionErrors.add(msg);
                }
            }
        }
    }

    private void resolveMethodSignatures(List<CompilationUnit> compilationUnits, List<String> resolutionErrors) {
        for (CompilationUnit cu : compilationUnits) {
            for (ClassOrInterfaceDeclaration cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String className = cls.getNameAsString();
                ClassInfo info = fqnIndex.values().stream()
                    .filter(ci -> ci.className.equals(className))
                    .findFirst().orElse(null);
                if (info == null) continue;

                for (MethodDeclaration methodDecl : cls.getMethods()) {
                    String methodName = methodDecl.getNameAsString();
                    MethodInfo mi = info.methods.stream()
                        .filter(m -> m.name.equals(methodName) && m.resolvedQualifiedSignature == null)
                        .findFirst().orElse(null);
                    if (mi == null) continue;

                    try {
                        ResolvedMethodDeclaration resolved = methodDecl.resolve();
                        mi.resolvedQualifiedSignature = resolved.getQualifiedSignature();
                    } catch (Exception e) {
                        String msg = "[RESOLVE-FAIL] method " + className + "." + methodName
                            + ": " + e.getClass().getSimpleName() + " - " + e.getMessage();
                        System.err.println(msg);
                        resolutionErrors.add(msg);
                        // Fallback sintático (ADR-0018): sem o solver, sintetiza a
                        // assinatura a partir do FONTE (fqn.nome(params-como-escritos)).
                        // O método vira NÓ do grafo mesmo com tipo externo no retorno/
                        // parâmetro (antes: método inteiro sumia e a cadeia quebrava).
                        mi.resolvedQualifiedSignature = info.fqn + "." + mi.name
                            + "(" + String.join(", ", mi.parameters) + ")";
                    }
                }
            }
        }
    }

    private void resolveRepositoryEntitiesViaGenerics(List<CompilationUnit> compilationUnits, List<String> resolutionErrors) {
        for (CompilationUnit cu : compilationUnits) {
            for (ClassOrInterfaceDeclaration cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
                String className = cls.getNameAsString();
                ClassInfo info = fqnIndex.values().stream()
                    .filter(ci -> ci.className.equals(className))
                    .findFirst().orElse(null);
                if (info == null || !info.isRepository) continue;

                List<ClassOrInterfaceType> superTypes = new ArrayList<>();
                superTypes.addAll(cls.getExtendedTypes());
                superTypes.addAll(cls.getImplementedTypes());

                for (ClassOrInterfaceType superType : superTypes) {
                    if (!REPO_INTERFACES.contains(superType.getNameAsString())) continue;
                    if (!superType.getTypeArguments().isPresent()) continue;

                    List<Type> typeArgs = superType.getTypeArguments().get();
                    if (typeArgs.isEmpty()) continue;

                    try {
                        ResolvedType entityType = typeArgs.get(0).resolve();
                        if (entityType.isReferenceType()) {
                            ResolvedReferenceTypeDeclaration entityDecl =
                                entityType.asReferenceType().getTypeDeclaration().orElse(null);
                            if (entityDecl != null) {
                                ClassInfo entityInfo = symbolClassMap.get(entityDecl);
                                if (entityInfo != null && entityInfo.isEntity) {
                                    info.resolvedEntitySymbol = entityDecl;
                                    info.resolvedEntityClassName = entityInfo.className;
                                    break;
                                }
                            }
                            String qualifiedName = entityType.asReferenceType().getQualifiedName();
                            String simpleName = qualifiedName.contains(".")
                                ? qualifiedName.substring(qualifiedName.lastIndexOf('.') + 1) : qualifiedName;
                            ClassInfo entityByFqn = fqnIndex.get(qualifiedName);
                            if (entityByFqn == null) {
                                entityByFqn = fqnIndex.values().stream()
                                    .filter(ci -> ci.className.equals(simpleName) && ci.isEntity)
                                    .findFirst().orElse(null);
                            }
                            if (entityByFqn != null && entityByFqn.isEntity) {
                                info.resolvedEntitySymbol = entityByFqn.resolvedSymbol;
                                info.resolvedEntityClassName = entityByFqn.className;
                                break;
                            }
                        }
                    } catch (Exception e) {
                        String msg = "Could not resolve entity generic for " + className + ": " + e.getMessage();
                        System.err.println(msg);
                        resolutionErrors.add(msg);
                    }

                    // Fallback sintático (ADR-0018): o argumento genérico está
                    // ESCRITO no fonte (JpaRepository<Contract, Long>) — resolve
                    // por import/pacote/nome-único, sem solver.
                    if (info.resolvedEntityClassName == null) {
                        String argType = typeArgs.get(0).asString();
                        int lt = argType.indexOf('<');
                        if (lt > 0) argType = argType.substring(0, lt);
                        ClassInfo viaSyntax = resolveTypeToClassInfo(info, argType.trim());
                        if (viaSyntax != null && viaSyntax.isEntity) {
                            info.resolvedEntitySymbol = viaSyntax.resolvedSymbol;
                            info.resolvedEntityClassName = viaSyntax.className;
                            break;
                        }
                    }
                }
            }
        }
    }

    private void debugListFiles(Path dir, String indent) {
        File[] files = dir.toFile().listFiles();
        if (files == null) return;
        for (File f : files) {
            System.err.println("[DEBUG-FS] " + indent + f.getName() + (f.isDirectory() ? "/" : ""));
            if (f.isDirectory()) {
                debugListFiles(f.toPath(), indent + "  ");
            }
        }
    }

    private Path writeFilesToTemp(Map<String, String> files) throws IOException {
        Path tempDir = Files.createTempDirectory("permacat-src-");

        for (Map.Entry<String, String> entry : files.entrySet()) {
            String filePath = entry.getKey();
            String content = entry.getValue();

            String packagePath = extractPackagePath(content);
            Path targetDir;
            if (packagePath != null) {
                targetDir = tempDir.resolve(packagePath.replace('.', File.separatorChar));
            } else {
                String dirPart = filePath.contains("/") ? filePath.substring(0, filePath.lastIndexOf('/')) : "";
                targetDir = dirPart.isEmpty() ? tempDir : tempDir.resolve(dirPart);
            }
            Files.createDirectories(targetDir);

            String fileName = filePath.contains("/") ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
            Path targetFile = targetDir.resolve(fileName);
            Files.writeString(targetFile, content);
        }

        return tempDir;
    }

    private String extractPackagePath(String content) {
        int idx = content.indexOf("package ");
        if (idx < 0) return null;
        int semi = content.indexOf(';', idx);
        if (semi < 0) return null;
        return content.substring(idx + 8, semi).trim();
    }

    private JavaParser configureParserWithSymbolSolver(Path sourceRoot) {
        CombinedTypeSolver combinedSolver = new CombinedTypeSolver();
        combinedSolver.add(new ReflectionTypeSolver(false));
        combinedSolver.add(new JavaParserTypeSolver(sourceRoot));

        JavaSymbolSolver symbolSolver = new JavaSymbolSolver(combinedSolver);

        ParserConfiguration config = new ParserConfiguration();
        config.setLanguageLevel(ParserConfiguration.LanguageLevel.BLEEDING_EDGE);
        config.setSymbolResolver(symbolSolver);

        return new JavaParser(config);
    }

    private void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }

    private void extractClassInfo(CompilationUnit cu, String filePath) {
        String packageName = cu.getPackageDeclaration()
            .map(pd -> pd.getNameAsString())
            .orElse("");

        // Onda 5: registra @interface do payload e suas meta-anotações — insumo
        // do fecho transitivo de estereótipos (applyMetaAnnotationClosure).
        for (AnnotationDeclaration ad : cu.findAll(AnnotationDeclaration.class)) {
            Set<String> metas = annotationMetas.computeIfAbsent(ad.getNameAsString(), k -> new HashSet<>());
            for (AnnotationExpr meta : ad.getAnnotations()) {
                metas.add(meta.getNameAsString());
            }
        }

        for (ClassOrInterfaceDeclaration cls : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            ClassInfo info = new ClassInfo();
            info.className = cls.getNameAsString();
            info.packageName = packageName;
            info.fqn = packageName.isEmpty() ? info.className : packageName + "." + info.className;
            info.sourceFile = filePath;
            info.isInterface = cls.isInterface();

            List<String> annotations = cls.getAnnotations().stream()
                .map(a -> a.getNameAsString())
                .collect(Collectors.toList());
            info.classAnnotationNames = annotations; // Onda 5: insumo do fecho

            info.isService = annotations.stream().anyMatch(SERVICE_ANNOTATIONS::contains);
            info.isRepository = annotations.stream().anyMatch(REPOSITORY_ANNOTATIONS::contains);
            info.isEntity = annotations.stream().anyMatch(ENTITY_ANNOTATIONS::contains);

            if (!info.isRepository && cls.isInterface()) {
                for (ClassOrInterfaceType ext : cls.getExtendedTypes()) {
                    if (REPO_INTERFACES.contains(ext.getNameAsString())) {
                        info.isRepository = true;
                        break;
                    }
                }
                for (ClassOrInterfaceType impl : cls.getImplementedTypes()) {
                    if (REPO_INTERFACES.contains(impl.getNameAsString())) {
                        info.isRepository = true;
                        break;
                    }
                }
            }

            if (!cls.getExtendedTypes().isEmpty()) {
                info.superClassName = cls.getExtendedTypes().get(0).getNameAsString();
            }

            // Wave 2: interfaces DECLARADAS pela classe (implements) + as que uma
            // interface estende (extends). Alimenta o índice interface→impl que
            // liga chamada-polimórfica (executor.execute()) à impl concreta.
            for (ClassOrInterfaceType impl : cls.getImplementedTypes()) {
                info.interfaceNames.add(impl.getNameAsString());
            }
            if (cls.isInterface()) {
                for (ClassOrInterfaceType ext : cls.getExtendedTypes()) {
                    info.interfaceNames.add(ext.getNameAsString());
                }
            }
            // Onda 4: CommandLineRunner/ApplicationRunner = entry-point da classe
            // (o método run() é acionado pelo boot do Spring, não por código nosso).
            info.isRunner = info.interfaceNames.stream().anyMatch(RUNNER_INTERFACES::contains);

            String classLevelPath = "";
            for (AnnotationExpr ann : cls.getAnnotations()) {
                if (ann.getNameAsString().equals("RequestMapping")) {
                    classLevelPath = extractMappingPath(ann);
                }
            }
            info.basePath = classLevelPath;

            if (info.isEntity) {
                extractEntityFields(cls, info);
                collectEntityAssociations(cls, info);
            }

            // Fallback sintático (ADR-0018): imports do CU (simples → FQN) e o
            // tipo DECLARADO de cada campo — determinístico, sem SymbolSolver.
            cu.getImports().forEach(imp -> {
                if (imp.isStatic() || imp.isAsterisk()) return;
                String fqnImp = imp.getNameAsString();
                int lastDot = fqnImp.lastIndexOf('.');
                String simple = lastDot >= 0 ? fqnImp.substring(lastDot + 1) : fqnImp;
                info.importsSimpleToFqn.putIfAbsent(simple, fqnImp);
            });
            for (FieldDeclaration fd : cls.getFields()) {
                for (VariableDeclarator vd : fd.getVariables()) {
                    String t = vd.getTypeAsString();
                    int lt = t.indexOf('<');
                    if (lt > 0) t = t.substring(0, lt); // remove genéricos
                    info.fieldTypes.putIfAbsent(vd.getNameAsString(), t.trim());
                }
            }

            extractMethods(cls, info);

            for (AnnotationExpr ann : cls.getAnnotations()) {
                if (SECURITY_ANNOTATIONS.contains(ann.getNameAsString())) {
                    info.securityAnnotations.add(extractSecurityAnnotation(ann));
                }
            }

            boolean hasClassAnnotation = annotations.stream().anyMatch(CONTROLLER_ANNOTATIONS::contains);
            boolean hasHttpMethods = info.methods.stream().anyMatch(m -> m.httpMethod != null);
            info.isController = hasClassAnnotation || hasHttpMethods;

            fqnIndex.put(info.fqn, info);
        }
    }

    private void resolveSuperclassBasePaths() {
        for (ClassInfo info : fqnIndex.values()) {
            if (!info.isController) continue;
            if (!info.basePath.isEmpty()) continue;

            String resolvedPath = resolveBasepathFromSuperclass(info, new HashSet<>());
            if (resolvedPath != null && !resolvedPath.isEmpty()) {
                info.basePath = resolvedPath;
                for (MethodInfo m : info.methods) {
                    if (m.httpMethod != null) {
                        m.httpPath = combinePaths(resolvedPath, m.httpPath != null ? m.httpPath : "");
                    }
                }
                System.out.println("[java-engine] Resolved superclass basePath for " + info.className + ": " + resolvedPath);
            }
        }
    }

    private String resolveBasepathFromSuperclass(ClassInfo info, Set<String> visited) {
        if (info.superClassName == null) return null;
        if (!visited.add(info.fqn)) return null;

        for (ClassInfo candidate : fqnIndex.values()) {
            if (candidate.className.equals(info.superClassName)) {
                if (!candidate.basePath.isEmpty()) {
                    return candidate.basePath;
                }
                String parentPath = resolveBasepathFromSuperclass(candidate, visited);
                if (parentPath != null && !parentPath.isEmpty()) {
                    return parentPath;
                }
            }
        }
        return null;
    }

    private static final Set<String> SENSITIVE_FIELD_NAMES = Set.of(
        "password", "passwd", "secret", "token", "apiKey", "apiSecret",
        "creditCard", "cardNumber", "cvv", "ssn", "socialSecurity",
        "cpf", "rg", "salary", "income", "bankAccount"
    );
    private static final Set<String> VALIDATION_ANNOTATIONS = Set.of(
        "NotNull", "NotBlank", "NotEmpty", "Size", "Min", "Max",
        "Pattern", "Email", "Past", "Future", "Positive", "Negative",
        "DecimalMin", "DecimalMax", "Digits", "Valid", "UniqueElements"
    );

    private void extractEntityFields(ClassOrInterfaceDeclaration cls, ClassInfo info) {
        for (FieldDeclaration field : cls.getFields()) {
            for (VariableDeclarator var : field.getVariables()) {
                EntityField ef = new EntityField();
                ef.name = var.getNameAsString();
                ef.type = var.getTypeAsString();
                ef.isId = field.getAnnotations().stream()
                    .anyMatch(a -> a.getNameAsString().equals("Id") || a.getNameAsString().equals("EmbeddedId"));

                for (AnnotationExpr ann : field.getAnnotations()) {
                    if (VALIDATION_ANNOTATIONS.contains(ann.getNameAsString())) {
                        ef.validationAnnotations.add(ann.toString());
                    }
                }

                String lowerName = ef.name.toLowerCase();
                ef.isSensitive = SENSITIVE_FIELD_NAMES.stream()
                    .anyMatch(s -> lowerName.contains(s.toLowerCase()))
                    || field.getAnnotations().stream()
                        .anyMatch(a -> a.getNameAsString().equals("JsonIgnore")
                            || a.getNameAsString().equals("JsonProperty") && a.toString().contains("access = Access.WRITE_ONLY"));

                info.entityFields.add(ef);
            }
        }
    }

    /**
     * Onda 3a (ADR-0025): associações JPA declaradas nos CAMPOS da entidade
     * (@OneToMany/@ManyToOne/@OneToOne/@ManyToMany/@Embedded/@ElementCollection).
     * O tipo-alvo é o argumento genérico quando coleção (List<Filha> → Filha;
     * Map<K,V> → V) ou o tipo declarado. Resolve pra ClassInfo no buildGraph
     * (import→pacote→nome único — precisão acima de recall).
     */
    private void collectEntityAssociations(ClassOrInterfaceDeclaration cls, ClassInfo info) {
        for (FieldDeclaration field : cls.getFields()) {
            String kind = null;
            for (AnnotationExpr ann : field.getAnnotations()) {
                if (ASSOCIATION_ANNOTATIONS.contains(ann.getNameAsString())) {
                    kind = ann.getNameAsString();
                    break;
                }
            }
            if (kind == null) continue;
            for (VariableDeclarator vd : field.getVariables()) {
                String t = vd.getTypeAsString();
                int lt = t.indexOf('<');
                if (lt > 0) {
                    int gt = t.lastIndexOf('>');
                    t = t.substring(lt + 1, gt > lt ? gt : t.length());
                    int comma = t.lastIndexOf(',');
                    if (comma > 0) t = t.substring(comma + 1); // Map<K,V> → V
                }
                info.entityAssociations.add(new String[]{ t.trim(), kind });
            }
        }
    }

    /** Valor string de @Query("…") — single-member ou value= (senão null). */
    private String extractAnnotationStringValue(AnnotationExpr ann) {
        if (ann instanceof SingleMemberAnnotationExpr) {
            var v = ((SingleMemberAnnotationExpr) ann).getMemberValue();
            if (v.isStringLiteralExpr()) return v.asStringLiteralExpr().getValue();
        } else if (ann instanceof NormalAnnotationExpr) {
            for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                if (pair.getNameAsString().equals("value") && pair.getValue().isStringLiteralExpr()) {
                    return pair.getValue().asStringLiteralExpr().getValue();
                }
            }
        }
        return null;
    }

    /** Onda 3b: literais JPQL passados a em.createQuery("…") no corpo do método. */
    private void collectJpqlLiterals(BlockStmt body, MethodInfo mi) {
        body.accept(new VoidVisitorAdapter<Void>() {
            @Override
            public void visit(MethodCallExpr callExpr, Void arg) {
                super.visit(callExpr, arg);
                if (!callExpr.getNameAsString().equals("createQuery")) return;
                if (callExpr.getArguments().isEmpty()) return;
                var first = callExpr.getArguments().get(0);
                if (first.isStringLiteralExpr()) {
                    mi.jpqlStrings.add(first.asStringLiteralExpr().getValue());
                }
            }
        }, null);
    }

    private static final java.util.regex.Pattern JPQL_FROM =
        java.util.regex.Pattern.compile("(?i)\\bfrom\\s+([A-Za-z_][A-Za-z0-9_]*)");
    private static final java.util.regex.Pattern JPQL_UPDATE =
        java.util.regex.Pattern.compile("(?i)^\\s*update\\s+([A-Za-z_][A-Za-z0-9_]*)");
    private static final java.util.regex.Pattern JPQL_JOIN_ENTITY =
        java.util.regex.Pattern.compile("\\bjoin\\s+(?:fetch\\s+)?([A-Z][A-Za-z0-9_]*)\\b");

    static class JpqlFacts {
        String op; // "read" | "write"
        List<String> entities = new ArrayList<>();
    }

    /**
     * Onda 3b: extrai da string JPQL a operação (update/delete = write; senão read)
     * e os NOMES DE ENTIDADE — o token após FROM (incl. "delete from X"), o alvo de
     * UPDATE e joins de ENTIDADE ("join Payment p"; "join u.roles" é path de
     * associação — minúsculo/com ponto — e fica fora, conservador). Query dinâmica
     * concatenada não chega aqui (só literais) — limite honesto declarado na ADR.
     */
    JpqlFacts parseJpql(String jpql) {
        JpqlFacts f = new JpqlFacts();
        String s = jpql == null ? "" : jpql.trim();
        boolean isWrite = s.regionMatches(true, 0, "update", 0, 6)
            || s.regionMatches(true, 0, "delete", 0, 6);
        f.op = isWrite ? "write" : "read";
        Set<String> seen = new LinkedHashSet<>();
        var mu = JPQL_UPDATE.matcher(s);
        if (mu.find()) seen.add(mu.group(1));
        var mf = JPQL_FROM.matcher(s);
        while (mf.find()) seen.add(mf.group(1));
        var mj = JPQL_JOIN_ENTITY.matcher(s);
        while (mj.find()) seen.add(mj.group(1));
        f.entities.addAll(seen);
        return f;
    }

    private SecurityAnnotation extractSecurityAnnotation(AnnotationExpr ann) {
        String type = ann.getNameAsString();
        String expression = "";
        List<String> roles = new ArrayList<>();

        if (type.equals("DenyAll")) {
            return new SecurityAnnotation(type, "denyAll", List.of("NONE"));
        }
        if (type.equals("PermitAll")) {
            return new SecurityAnnotation(type, "permitAll", List.of("*"));
        }

        if (ann instanceof SingleMemberAnnotationExpr) {
            expression = ((SingleMemberAnnotationExpr) ann).getMemberValue().toString()
                .replace("\"", "");
            roles = extractRolesFromExpression(type, expression);
        } else if (ann instanceof NormalAnnotationExpr) {
            for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                if (pair.getNameAsString().equals("value")) {
                    expression = pair.getValue().toString().replace("\"", "");
                    roles = extractRolesFromExpression(type, expression);
                    break;
                }
            }
        }

        return new SecurityAnnotation(type, expression, roles);
    }

    private List<String> extractRolesFromExpression(String annotationType, String expression) {
        List<String> roles = new ArrayList<>();

        if (annotationType.equals("Secured") || annotationType.equals("RolesAllowed")) {
            String cleaned = expression.replace("{", "").replace("}", "").replace("\"", "").trim();
            for (String role : cleaned.split(",")) {
                String r = role.trim();
                if (!r.isEmpty()) roles.add(r);
            }
            return roles;
        }

        if (annotationType.equals("PreAuthorize")) {
            java.util.regex.Matcher m;
            m = java.util.regex.Pattern.compile("hasRole\\(['\"]?(ROLE_)?([^'\"\\)]+)['\"]?\\)").matcher(expression);
            while (m.find()) roles.add("ROLE_" + m.group(2));

            m = java.util.regex.Pattern.compile("hasAuthority\\(['\"]?([^'\"\\)]+)['\"]?\\)").matcher(expression);
            while (m.find()) roles.add(m.group(1));

            m = java.util.regex.Pattern.compile("hasAnyRole\\(['\"]?([^\\)]+)['\"]?\\)").matcher(expression);
            if (m.find()) {
                for (String role : m.group(1).split("[,'\"]")) {
                    String r = role.trim();
                    if (!r.isEmpty()) roles.add(r.startsWith("ROLE_") ? r : "ROLE_" + r);
                }
            }

            m = java.util.regex.Pattern.compile("hasAnyAuthority\\(['\"]?([^\\)]+)['\"]?\\)").matcher(expression);
            if (m.find()) {
                for (String role : m.group(1).split("[,'\"]")) {
                    String r = role.trim();
                    if (!r.isEmpty()) roles.add(r);
                }
            }
        }

        return roles;
    }

    private void extractMethods(ClassOrInterfaceDeclaration cls, ClassInfo info) {
        for (MethodDeclaration method : cls.getMethods()) {
            MethodInfo mi = new MethodInfo();
            mi.name = method.getNameAsString();
            mi.returnType = method.getTypeAsString();
            mi.parameters = method.getParameters().stream()
                .map(p -> p.getTypeAsString() + " " + p.getNameAsString())
                .collect(Collectors.toList());
            method.getParameters().forEach(par -> {
                String t = par.getTypeAsString();
                int lt = t.indexOf('<');
                if (lt > 0) t = t.substring(0, lt);
                mi.paramTypesByName.put(par.getNameAsString(), t.trim());
            });
            method.getBody().ifPresent(b -> b.findAll(VariableDeclarator.class).forEach(vd -> {
                String t = vd.getTypeAsString();
                int lt = t.indexOf('<');
                if (lt > 0) t = t.substring(0, lt);
                mi.localVarTypes.putIfAbsent(vd.getNameAsString(), t.trim());
            }));

            for (AnnotationExpr ann : method.getAnnotations()) {
                String annName = ann.getNameAsString();
                if (MAPPING_ANNOTATIONS.contains(annName)) {
                    mi.httpMethod = resolveHttpMethod(annName, ann);
                    String methodPath = extractMappingPath(ann);
                    mi.httpPath = combinePaths(info.basePath, methodPath);
                }
                if (SECURITY_ANNOTATIONS.contains(annName)) {
                    mi.securityAnnotations.add(extractSecurityAnnotation(ann));
                }
                // Onda 4: gatilho de fundo (@Scheduled/@EventListener/@KafkaListener…)
                if (ENTRY_POINT_ANNOTATIONS.contains(annName)) {
                    mi.entryPointKind = annName;
                }
                // Onda 3b: JPQL declarado em @Query no método (repositórios)
                if (annName.equals("Query")) {
                    String jpql = extractAnnotationStringValue(ann);
                    if (jpql != null) mi.jpqlStrings.add(jpql);
                }
            }
            // Onda 4: run() de CommandLineRunner/ApplicationRunner é acionado pelo boot
            if (info.isRunner && mi.name.equals("run") && mi.entryPointKind == null) {
                mi.entryPointKind = "ApplicationRunner";
            }

            if (method.getBody().isPresent()) {
                BlockStmt body = method.getBody().get();
                extractMethodCalls(body, mi);
                detectEntityMutations(body, mi);
                detectProgrammaticSecurity(body, mi);
                collectJpqlLiterals(body, mi); // Onda 3b: em.createQuery("…")
            }

            info.methods.add(mi);
        }
    }

    private void extractMethodCalls(BlockStmt body, MethodInfo mi) {
        body.accept(new VoidVisitorAdapter<Void>() {
            @Override
            public void visit(MethodCallExpr callExpr, Void arg) {
                super.visit(callExpr, arg);

                try {
                    ResolvedMethodDeclaration resolved = callExpr.resolve();
                    ResolvedReferenceTypeDeclaration declaringType = resolved.declaringType();

                    MethodCallInfo mci = new MethodCallInfo();
                    mci.methodName = callExpr.getNameAsString();
                    mci.resolvedDeclaringType = declaringType;
                    mci.resolvedSignature = resolved.getQualifiedSignature();
                    mci.resolvedMethodSignature = resolved.getSignature();
                    mci.resolvedReturnType = resolved.getReturnType().describe();

                    if (callExpr.getScope().isPresent()) {
                        try {
                            com.github.javaparser.resolution.types.ResolvedType scopeType =
                                callExpr.getScope().get().calculateResolvedType();
                            if (scopeType.isReferenceType()) {
                                mci.resolvedScopeType = scopeType.asReferenceType().getTypeDeclaration().orElse(null);
                            }
                        } catch (Exception ignore) {}
                    }

                    mi.methodCalls.add(mci);
                } catch (Exception e) {
                    // Fallback sintático (ADR-0018): o resolve() falha para QUALQUER
                    // chamada cujo tipo declarante/argumento não está no classpath —
                    // ex.: repo.save()/findById() herdados do JpaRepository (externo).
                    // O catch vazio descartava a chamada e a cadeia morria sem a
                    // entidade. Agora gravamos os FATOS SINTÁTICOS (nome do método,
                    // nome simples do escopo, aridade) e o grafo liga depois pelo
                    // tipo DECLARADO do campo (padrão DI dominante). Precisão:
                    // só escopo simples (campo/variável/this.campo) — encadeado não.
                    MethodCallInfo fb = new MethodCallInfo();
                    fb.methodName = callExpr.getNameAsString();
                    fb.argCount = callExpr.getArguments().size();
                    callExpr.getArguments().forEach(a -> {
                        if (a.isNameExpr()) {
                            fb.argNames.add(a.asNameExpr().getNameAsString());
                        } else if (a.isClassExpr()) {
                            String t = a.asClassExpr().getTypeAsString();
                            int lt = t.indexOf('<');
                            if (lt > 0) t = t.substring(0, lt);
                            fb.argClassLiterals.add(t.trim());
                        }
                    });
                    if (callExpr.getScope().isPresent()) {
                        var scope = callExpr.getScope().get();
                        if (scope.isNameExpr()) {
                            fb.fallbackScopeName = scope.asNameExpr().getNameAsString();
                        } else if (scope.isFieldAccessExpr() && scope.asFieldAccessExpr().getScope().isThisExpr()) {
                            fb.fallbackScopeName = scope.asFieldAccessExpr().getNameAsString();
                        } else {
                            return; // escopo encadeado/complexo: conservador, não liga
                        }
                    } else {
                        fb.fallbackUnqualified = true; // helper da própria classe
                    }
                    mi.methodCalls.add(fb);
                }
            }
        }, null);
    }

    private static final Set<String> SECURITY_CHECK_METHODS = Set.of(
        "hasRole", "hasAuthority", "hasPermission", "hasAccess",
        "checkPermission", "checkAccess", "authorize", "isAllowed", "isAuthorized",
        "isAuthenticated", "checkRole", "validatePermission", "verifyPermission",
        "requireRole", "requirePermission", "requireAuth", "requireAuthentication"
    );

    private void detectProgrammaticSecurity(BlockStmt body, MethodInfo mi) {
        body.accept(new VoidVisitorAdapter<Void>() {
            @Override
            public void visit(MethodCallExpr callExpr, Void arg) {
                super.visit(callExpr, arg);
                String methodName = callExpr.getNameAsString();

                if (SECURITY_CHECK_METHODS.contains(methodName)) {
                    String expression = callExpr.toString();
                    List<String> roles = extractRolesFromProgrammaticCall(callExpr);
                    mi.securityAnnotations.add(new SecurityAnnotation(
                        "Programmatic:" + methodName, expression, roles
                    ));
                    return;
                }

                if (methodName.equals("getAuthentication") || methodName.equals("getContext")) {
                    if (callExpr.getScope().isPresent()) {
                        String scope = callExpr.getScope().get().toString();
                        if (scope.contains("SecurityContextHolder") || scope.contains("SecurityContext")) {
                            mi.securityAnnotations.add(new SecurityAnnotation(
                                "Programmatic:SecurityContext", callExpr.toString(), List.of()
                            ));
                        }
                    }
                }

                if (methodName.equals("isUserInRole") && callExpr.getScope().isPresent()) {
                    List<String> roles = new ArrayList<>();
                    for (var argExpr : callExpr.getArguments()) {
                        if (argExpr.isStringLiteralExpr()) {
                            roles.add(argExpr.asStringLiteralExpr().getValue());
                        }
                    }
                    mi.securityAnnotations.add(new SecurityAnnotation(
                        "Programmatic:isUserInRole", callExpr.toString(), roles
                    ));
                }
            }
        }, null);
    }

    private List<String> extractRolesFromProgrammaticCall(MethodCallExpr callExpr) {
        List<String> roles = new ArrayList<>();
        for (var argExpr : callExpr.getArguments()) {
            if (argExpr.isStringLiteralExpr()) {
                String val = argExpr.asStringLiteralExpr().getValue();
                if (val.startsWith("ROLE_") || val.matches("[A-Z_]{3,}")) {
                    roles.add(val);
                }
            }
        }
        return roles;
    }

    private void detectEntityMutations(BlockStmt body, MethodInfo mi) {
        body.accept(new VoidVisitorAdapter<Void>() {
            @Override
            public void visit(MethodCallExpr callExpr, Void arg) {
                super.visit(callExpr, arg);
                String name = callExpr.getNameAsString();
                if (name.startsWith("set") && name.length() > 3 && Character.isUpperCase(name.charAt(3))) {
                    mi.hasEntityMutations = true;
                }
            }
        }, null);
    }

    private String resolveHttpMethod(String annotationName, AnnotationExpr ann) {
        switch (annotationName) {
            case "GetMapping": return "GET";
            case "PostMapping": return "POST";
            case "PutMapping": return "PUT";
            case "DeleteMapping": return "DELETE";
            case "PatchMapping": return "PATCH";
            case "RequestMapping":
                if (ann instanceof NormalAnnotationExpr) {
                    for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                        if (pair.getNameAsString().equals("method")) {
                            String val = pair.getValue().toString();
                            if (val.contains("GET")) return "GET";
                            if (val.contains("POST")) return "POST";
                            if (val.contains("PUT")) return "PUT";
                            if (val.contains("DELETE")) return "DELETE";
                            if (val.contains("PATCH")) return "PATCH";
                        }
                    }
                }
                return "GET";
            default: return "GET";
        }
    }

    private String extractMappingPath(AnnotationExpr ann) {
        if (ann instanceof SingleMemberAnnotationExpr) {
            return cleanPath(((SingleMemberAnnotationExpr) ann).getMemberValue().toString());
        }
        if (ann instanceof NormalAnnotationExpr) {
            for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                String key = pair.getNameAsString();
                if (key.equals("value") || key.equals("path")) {
                    return cleanPath(pair.getValue().toString());
                }
            }
        }
        if (ann instanceof MarkerAnnotationExpr) {
            return "";
        }
        return "";
    }

    private String cleanPath(String raw) {
        String path = raw.replace("\"", "").replace("{", "").replace("}", "").trim();
        if (path.startsWith("/")) return path;
        if (!path.isEmpty()) return "/" + path;
        return "";
    }

    private String combinePaths(String base, String methodPath) {
        String combined = (base + methodPath).replaceAll("/+", "/");
        if (!combined.startsWith("/")) combined = "/" + combined;
        if (combined.endsWith("/") && combined.length() > 1) {
            combined = combined.substring(0, combined.length() - 1);
        }
        return combined;
    }

    private String resolvedEntityNodeId(ClassInfo cls) {
        if (cls.resolvedSymbol != null) {
            return "ENTITY:" + cls.resolvedSymbol.getQualifiedName();
        }
        return "ENTITY:" + cls.fqn;
    }

    private String resolvedClassNodeId(String nodeType, ClassInfo cls) {
        if (cls.resolvedSymbol != null) {
            return nodeType + ":" + cls.resolvedSymbol.getQualifiedName();
        }
        return nodeType + ":" + cls.fqn;
    }

    private String requalifySignature(String resolvedSignature, String targetQualifiedName) {
        int parenIdx = resolvedSignature.indexOf('(');
        if (parenIdx < 0) return targetQualifiedName + "." + resolvedSignature;
        int dotBeforeParen = resolvedSignature.lastIndexOf('.', parenIdx);
        if (dotBeforeParen < 0) return targetQualifiedName + "." + resolvedSignature;
        String methodPart = resolvedSignature.substring(dotBeforeParen + 1);
        return targetQualifiedName + "." + methodPart;
    }

    /**
     * Fallback sintático (ADR-0018): resolve um tipo SIMPLES declarado no fonte
     * para a ClassInfo do projeto, sem SymbolSolver — import explícito do CU →
     * mesmo pacote → nome simples ÚNICO no projeto (ambíguo = null; precisão
     * acima de recall: nunca liga no chute).
     */
    private ClassInfo resolveTypeToClassInfo(ClassInfo caller, String simpleType) {
        if (simpleType == null || simpleType.isEmpty()) return null;
        String viaImport = caller.importsSimpleToFqn.get(simpleType);
        if (viaImport != null) {
            ClassInfo byFqn = fqnIndex.get(viaImport);
            if (byFqn != null) return byFqn;
        }
        if (caller.packageName != null && !caller.packageName.isEmpty()) {
            ClassInfo samePkg = fqnIndex.get(caller.packageName + "." + simpleType);
            if (samePkg != null) return samePkg;
        }
        ClassInfo unique = null;
        for (ClassInfo ci : fqnIndex.values()) {
            if (ci.className.equals(simpleType)) {
                if (unique != null) return null; // ambíguo — não liga
                unique = ci;
            }
        }
        return unique;
    }

    /**
     * ADR-0026 EXT1 — resolve um supertipo/interface (nome simples) para o id do
     * nó ALVO, mintando um nó INTERFACE/SUPERTYPE quando o tipo pertence ao código
     * analisado mas ainda não é nó (base class / interface de contrato). Retorna
     * null quando o tipo é EXTERNO (framework: JpaRepository, Serializable,
     * Object…) — precisão acima de recall: nunca minta tipo que não é do projeto.
     * Controller/Service são método-only hoje (sem nó de classe) → null nesta
     * fatia (a fatia de nós-de-classe os cobrirá).
     */
    private String resolveOrMintSupertypeNode(ClassInfo caller, String simpleType,
                                              List<GraphNodeDTO> nodes, Set<String> nodeIds) {
        ClassInfo target = resolveTypeToClassInfo(caller, simpleType);
        if (target == null || target == caller) return null;
        if (target.isEntity) {
            String id = resolvedEntityNodeId(target);
            return nodeIds.contains(id) ? id : null;
        }
        if (target.isRepository) {
            String id = resolvedClassNodeId("REPOSITORY", target);
            return nodeIds.contains(id) ? id : null;
        }
        if (target.isController || target.isService) {
            return null; // método-only hoje — sem nó de classe p/ ancorar a aresta
        }
        String nodeType = target.isInterface ? "INTERFACE" : "SUPERTYPE";
        String id = resolvedClassNodeId(nodeType, target);
        if (nodeIds.add(id)) {
            GraphNodeDTO n = new GraphNodeDTO(nodeType, target.className, null,
                target.resolvedSymbol != null ? target.resolvedSymbol.getQualifiedName() : target.fqn);
            n.metadata.put("sourceFile", target.sourceFile);
            n.metadata.put("synthetic", true);
            nodes.add(n);
        }
        return id;
    }

    /** Wave 2: impls do projeto (que viram nó) de uma interface pelo nome simples. */
    private List<ClassInfo> implsOf(String interfaceSimpleName) {
        List<ClassInfo> l = implsBySimpleName.get(interfaceSimpleName);
        return l != null ? l : Collections.emptyList();
    }

    /**
     * Resolve o id do nó de método ALVO (não-repo) de uma chamada, no `tgt` dado.
     * Requalifica a assinatura resolvida pro FQN do alvo (cobre o fan-out
     * interface→impl: a assinatura vem da interface, o nó é da impl) e cai pro
     * casamento por NOME+aridade quando não há assinatura. Retorna null se o alvo
     * não tiver o método (impl que não sobrescreve aquele método da interface).
     */
    private String resolveCalleeNodeId(ClassInfo tgt, MethodCallInfo call,
                                       Map<String, String> signatureToNodeId) {
        String targetQualifiedName = tgt.resolvedSymbol != null
            ? tgt.resolvedSymbol.getQualifiedName() : tgt.fqn;
        if (call.resolvedSignature != null) {
            String requalified = requalifySignature(call.resolvedSignature, targetQualifiedName);
            String toId = signatureToNodeId.get(requalified);
            if (toId != null) return toId;
            // fan-out: a impl tem o método com o MESMO nome mas assinatura própria
            MethodInfo byName = matchMethodByNameArity(tgt, call);
            if (byName != null && byName.resolvedQualifiedSignature != null) {
                toId = signatureToNodeId.get(byName.resolvedQualifiedSignature);
                if (toId != null) return toId;
            }
            return signatureToNodeId.get(call.resolvedSignature);
        }
        MethodInfo tm = matchMethodByNameArity(tgt, call);
        if (tm != null && tm.resolvedQualifiedSignature != null) {
            return signatureToNodeId.get(tm.resolvedQualifiedSignature);
        }
        return null;
    }

    private MethodInfo matchMethodByNameArity(ClassInfo tgt, MethodCallInfo call) {
        MethodInfo tm = null;
        for (MethodInfo cand : tgt.methods) {
            if (!cand.name.equals(call.methodName)) continue;
            if (cand.parameters.size() == call.argCount) return cand;
            if (tm == null) tm = cand;
        }
        return tm;
    }

    private AnalysisResult buildGraph(List<String> resolutionErrors) {
        List<GraphNodeDTO> nodes = new ArrayList<>();
        List<GraphEdgeDTO> edges = new ArrayList<>();
        Set<String> nodeIds = new HashSet<>();
        Set<String> edgeKeys = new HashSet<>();
        Map<String, String> signatureToNodeId = new HashMap<>();

        // Wave 2: índice interface(nome simples)→impls do projeto. Só classes que
        // viram nó (não-entidade) entram como impl. Construído 1× por análise.
        implsBySimpleName.clear();
        for (ClassInfo ci : fqnIndex.values()) {
            if (ci.isEntity) continue;
            for (String iface : ci.interfaceNames) {
                implsBySimpleName.computeIfAbsent(iface, k -> new ArrayList<>()).add(ci);
            }
        }

        for (ClassInfo cls : fqnIndex.values()) {
            if (cls.isEntity) {
                String entityQualifiedName = cls.resolvedSymbol != null
                    ? cls.resolvedSymbol.getQualifiedName() : cls.fqn;
                GraphNodeDTO entityNode = new GraphNodeDTO(
                    "ENTITY", cls.className, null, entityQualifiedName);
                entityNode.metadata.put("sourceFile", cls.sourceFile);
                entityNode.metadata.put("fields", cls.entityFields.stream()
                    .map(f -> f.name + ":" + f.type)
                    .collect(Collectors.toList()));
                List<Map<String, Object>> enrichedFields = new ArrayList<>();
                List<String> sensitiveFields = new ArrayList<>();
                for (EntityField ef : cls.entityFields) {
                    Map<String, Object> fm = new HashMap<>();
                    fm.put("name", ef.name);
                    fm.put("type", ef.type);
                    fm.put("isId", ef.isId);
                    fm.put("isSensitive", ef.isSensitive);
                    if (!ef.validationAnnotations.isEmpty()) {
                        fm.put("validations", ef.validationAnnotations);
                    }
                    enrichedFields.add(fm);
                    if (ef.isSensitive) sensitiveFields.add(ef.name);
                }
                entityNode.metadata.put("enrichedFields", enrichedFields);
                if (!sensitiveFields.isEmpty()) {
                    entityNode.metadata.put("sensitiveFields", sensitiveFields);
                }
                if (nodeIds.add(entityNode.id)) {
                    nodes.add(entityNode);
                }
            }
        }

        // Onda 3a (ADR-0025): associações JPA entidade→entidade. Fecha a ilha das
        // entidades-FILHAS (ReferenceTableRow, SlaTemplateIndicator, attachments…)
        // que não têm JpaRepository próprio — o pai as alcança por cascade.
        for (ClassInfo cls : fqnIndex.values()) {
            if (!cls.isEntity || cls.entityAssociations.isEmpty()) continue;
            String fromId = resolvedEntityNodeId(cls);
            if (!nodeIds.contains(fromId)) continue;
            for (String[] assoc : cls.entityAssociations) {
                ClassInfo target = resolveTypeToClassInfo(cls, assoc[0]);
                if (target == null || !target.isEntity || target == cls) continue;
                String toId = resolvedEntityNodeId(target);
                if (!nodeIds.contains(toId) || toId.equals(fromId)) continue;
                addEdge(edges, edgeKeys, fromId, toId, "ASSOCIATES",
                    Map.of("kind", assoc[1], "resolution", "syntactic-declared"));
            }
        }

        for (ClassInfo cls : fqnIndex.values()) {
            if (cls.isEntity) continue;

            String nodeType;
            if (cls.isController) nodeType = "CONTROLLER";
            else if (cls.isService) nodeType = "SERVICE";
            else if (cls.isRepository) nodeType = "REPOSITORY";
            else continue;

            if (cls.isRepository) {
                String repoQualifiedName = cls.resolvedSymbol != null
                    ? cls.resolvedSymbol.getQualifiedName() : cls.fqn;
                GraphNodeDTO repoNode = new GraphNodeDTO(
                    "REPOSITORY", cls.className, null, repoQualifiedName);
                repoNode.metadata.put("sourceFile", cls.sourceFile);
                if (nodeIds.add(repoNode.id)) {
                    nodes.add(repoNode);
                }

                ClassInfo entityInfo = resolveEntityClassForRepository(cls);
                if (entityInfo != null) {
                    String entityNodeId = resolvedEntityNodeId(entityInfo);
                    if (nodeIds.contains(entityNodeId)) {
                        addEdge(edges, edgeKeys, repoNode.id, entityNodeId, "READS_ENTITY",
                            Map.of("operation", "read", "resolution", "syntactic-resolved"));
                    }
                }

                // Onda 3b (ADR-0025): @Query JPQL nos métodos do repositório —
                // alcança entidades ALÉM da do genérico (joins/updates/deletes).
                for (MethodInfo m : cls.methods) {
                    for (String jpql : m.jpqlStrings) {
                        JpqlFacts f = parseJpql(jpql);
                        for (String ent : f.entities) {
                            ClassInfo entCi = resolveTypeToClassInfo(cls, ent);
                            if (entCi == null || !entCi.isEntity) continue;
                            String entityNodeId = resolvedEntityNodeId(entCi);
                            if (!nodeIds.contains(entityNodeId)) continue;
                            addEdge(edges, edgeKeys, repoNode.id, entityNodeId,
                                "write".equals(f.op) ? "WRITES_ENTITY" : "READS_ENTITY",
                                Map.of("operation", "jpql", "resolution", "syntactic-declared"));
                        }
                    }
                }
            }

            for (MethodInfo method : cls.methods) {
                if (cls.isController && method.httpMethod == null) continue;
                if (method.resolvedQualifiedSignature == null) continue;

                Map<String, Object> meta = new HashMap<>();
                meta.put("sourceFile", cls.sourceFile);
                if (method.httpMethod != null) {
                    meta.put("httpMethod", method.httpMethod);
                    meta.put("fullPath", method.httpPath);
                }
                meta.put("returnType", method.returnType);
                meta.put("parameters", method.parameters);
                // Onda 4: gatilho de fundo — a tela/shaper distinguem "root
                // legítimo" (cron/evento/boot) de "isolado injustificado".
                if (method.entryPointKind != null) {
                    meta.put("entryPoint", method.entryPointKind);
                }

                List<SecurityAnnotation> allSecAnn = new ArrayList<>(cls.securityAnnotations);
                allSecAnn.addAll(method.securityAnnotations);
                if (!allSecAnn.isEmpty()) {
                    List<Map<String, Object>> secList = new ArrayList<>();
                    Set<String> allRoles = new LinkedHashSet<>();
                    for (SecurityAnnotation sa : allSecAnn) {
                        Map<String, Object> secMap = new HashMap<>();
                        secMap.put("type", sa.type);
                        secMap.put("expression", sa.expression);
                        secMap.put("roles", sa.roles);
                        secList.add(secMap);
                        allRoles.addAll(sa.roles);
                    }
                    meta.put("securityAnnotations", secList);
                    meta.put("requiredRoles", new ArrayList<>(allRoles));
                }

                GraphNodeDTO node = new GraphNodeDTO(
                    nodeType, cls.className, method.name,
                    method.resolvedQualifiedSignature, meta);
                if (nodeIds.add(node.id)) {
                    nodes.add(node);
                    signatureToNodeId.put(method.resolvedQualifiedSignature, node.id);
                }
            }
        }

        for (ClassInfo cls : fqnIndex.values()) {
            if (cls.isEntity) continue;

            String nodeType;
            if (cls.isController) nodeType = "CONTROLLER";
            else if (cls.isService) nodeType = "SERVICE";
            else if (cls.isRepository) nodeType = "REPOSITORY";
            else continue;

            for (MethodInfo method : cls.methods) {
                if (cls.isController && method.httpMethod == null) continue;
                if (method.resolvedQualifiedSignature == null) continue;

                String fromId = nodeType + ":" + method.resolvedQualifiedSignature;
                if (!nodeIds.contains(fromId)) continue;

                // Onda 3b (ADR-0025): em.createQuery("…") no corpo do método —
                // persistência sem repositório vira aresta método→entidade.
                for (String jpql : method.jpqlStrings) {
                    JpqlFacts f = parseJpql(jpql);
                    for (String ent : f.entities) {
                        ClassInfo entCi = resolveTypeToClassInfo(cls, ent);
                        if (entCi == null || !entCi.isEntity) continue;
                        String entityNodeId = resolvedEntityNodeId(entCi);
                        if (!nodeIds.contains(entityNodeId)) continue;
                        addEdge(edges, edgeKeys, fromId, entityNodeId,
                            "write".equals(f.op) ? "WRITES_ENTITY" : "READS_ENTITY",
                            Map.of("operation", "jpql", "resolution", "syntactic-declared"));
                    }
                }

                for (MethodCallInfo call : method.methodCalls) {
                    ClassInfo targetClass = symbolClassMap.get(call.resolvedDeclaringType);
                    if (targetClass == null && call.resolvedScopeType != null) {
                        targetClass = symbolClassMap.get(call.resolvedScopeType);
                    }

                    // ADR-0018: entidade via ARGUMENTO — o padrão de persistência
                    // do easynup é helper estático (Db.save(em(), contract) /
                    // Db.findOne(em(), Contract.class, id)): a entidade está no
                    // argumento, não no alvo. Guarda: SÓ para operação de
                    // persistência reconhecida (save/find/delete/exists/count...).
                    if (call.fallbackScopeName != null || call.fallbackUnqualified) {
                        String argOp = detectPersistenceOp(call.methodName);
                        if (argOp != null) {
                            List<String> candidateTypes = new ArrayList<>();
                            for (String an : call.argNames) {
                                String t = method.localVarTypes.get(an);
                                if (t == null) t = method.paramTypesByName.get(an);
                                if (t != null) candidateTypes.add(t);
                            }
                            candidateTypes.addAll(call.argClassLiterals);
                            for (String t : candidateTypes) {
                                ClassInfo entArg = resolveTypeToClassInfo(cls, t);
                                if (entArg != null && entArg.isEntity) {
                                    String entityNodeId = resolvedEntityNodeId(entArg);
                                    if (nodeIds.contains(entityNodeId)) {
                                        if (isWriteOp(argOp)) {
                                            addEdge(edges, edgeKeys, fromId, entityNodeId, "WRITES_ENTITY", Map.of("operation", argOp, "resolution", "syntactic-declared"));
                                        } else {
                                            addEdge(edges, edgeKeys, fromId, entityNodeId, "READS_ENTITY", Map.of("operation", argOp, "resolution", "syntactic-declared"));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Fallback sintático (ADR-0018): o resolve() falhou (chamada
                    // gravada só com fatos sintáticos) — liga pelo tipo DECLARADO
                    // do campo injetado (DI) ou pela própria classe (helper).
                    if (targetClass == null) {
                        if (call.fallbackUnqualified) {
                            targetClass = cls;
                        } else if (call.fallbackScopeName != null) {
                            // Campo injetado (DI) → var local (ex. `for (ActionExecutor
                            // executor : ...)`) → parâmetro. O último cobre o padrão
                            // de registro polimórfico que deixava as impls isoladas.
                            String declaredType = cls.fieldTypes.get(call.fallbackScopeName);
                            if (declaredType == null) declaredType = method.localVarTypes.get(call.fallbackScopeName);
                            if (declaredType == null) declaredType = method.paramTypesByName.get(call.fallbackScopeName);
                            if (declaredType != null) {
                                targetClass = resolveTypeToClassInfo(cls, declaredType);
                            }
                        }
                    }

                    if (targetClass == null) continue;

                    if (targetClass.isRepository) {
                        String repoQualifiedName = targetClass.resolvedSymbol != null
                            ? targetClass.resolvedSymbol.getQualifiedName() : targetClass.fqn;
                        String requalified = call.resolvedSignature != null
                            ? requalifySignature(call.resolvedSignature, repoQualifiedName)
                            : repoQualifiedName + "." + call.methodName + "(#" + Math.max(0, call.argCount) + ")";
                        String repoMethodNodeId = "REPOSITORY:" + requalified;

                        if (!nodeIds.contains(repoMethodNodeId)) {
                            GraphNodeDTO syntheticNode = new GraphNodeDTO(
                                "REPOSITORY", targetClass.className, call.methodName, requalified);
                            syntheticNode.metadata.put("synthetic", true);
                            syntheticNode.metadata.put("sourceFile", targetClass.sourceFile);
                            syntheticNode.metadata.put("resolvedFrom", call.resolvedSignature);
                            nodeIds.add(repoMethodNodeId);
                            nodes.add(syntheticNode);
                            signatureToNodeId.put(requalified, repoMethodNodeId);

                            ClassInfo entityInfo = resolveEntityClassForRepository(targetClass);
                            if (entityInfo != null) {
                                String entityNodeId = resolvedEntityNodeId(entityInfo);
                                if (nodeIds.contains(entityNodeId)) {
                                    String op = detectPersistenceOp(call.methodName);
                                    if (isWriteOp(op)) {
                                        addEdge(edges, edgeKeys, repoMethodNodeId, entityNodeId, "WRITES_ENTITY", Map.of("operation", op, "resolution", "syntactic-declared"));
                                    } else {
                                        addEdge(edges, edgeKeys, repoMethodNodeId, entityNodeId, "READS_ENTITY", Map.of("operation", op != null ? op : "read", "resolution", "syntactic-declared"));
                                    }
                                }
                            }
                        }
                        // T1 (ADR-0025): proveniência por aresta — resolvido pelo
                        // solver vs. ligado pelo tipo DECLARADO (fallback ADR-0018).
                        addEdge(edges, edgeKeys, fromId, repoMethodNodeId, "CALLS",
                            Map.of("resolution", call.resolvedSignature != null ? "syntactic-resolved" : "syntactic-declared"));
                    } else {
                        // Wave 2 — interface→impl fan-out: se o alvo é uma INTERFACE do
                        // projeto (ex. ActionExecutor/ConfigContentValidator chamados via
                        // registro polimórfico), liga a chamada a TODAS as impls concretas
                        // (padrão CHA; F4F/JackEE). Para grafo de ARQUITETURA, ver "usa a
                        // família toda" é o desejado; marca resolution=interface-impl p/
                        // honestidade/filtro. Sem impls (ou alvo concreto) = 1 aresta, como antes.
                        List<ClassInfo> targets;
                        boolean fanout = false;
                        if (targetClass.isInterface) {
                            List<ClassInfo> impls = implsOf(targetClass.className);
                            if (!impls.isEmpty()) { targets = impls; fanout = true; }
                            else { targets = Collections.singletonList(targetClass); }
                        } else {
                            targets = Collections.singletonList(targetClass);
                        }
                        for (ClassInfo tgt : targets) {
                            if (tgt.isRepository) continue; // impl repo já coberto pelo ramo acima
                            String toId = resolveCalleeNodeId(tgt, call, signatureToNodeId);
                            if (toId != null && nodeIds.contains(toId)) {
                                addEdge(edges, edgeKeys, fromId, toId, "CALLS",
                                    fanout ? Map.of("resolution", "interface-impl", "via", targetClass.className)
                                           : Map.of("resolution", call.resolvedSignature != null ? "syntactic-resolved" : "syntactic-declared"));
                            }
                        }
                    }
                }

                if (method.hasEntityMutations) {
                    handleEntityMutations(fromId, cls, edges, nodeIds, edgeKeys);
                }
            }
        }

        // ADR-0026 EXT1 — HERANÇA como aresta de 1ª classe (EXTENDS/IMPLEMENTS).
        // Roda depois de todos os nós existirem. Fonte = nós de CLASSE que já
        // existem (ENTITY, REPOSITORY). O supertipo/interface é resolvido ao
        // próprio código e mintado (INTERFACE/SUPERTYPE) se ainda não for nó — a
        // herança deixa de ser esparsa. Dado (superClassName/interfaceNames) já
        // era coletado e antes DESCARTADO. Controller/Service (método-only) ficam
        // p/ a fatia de nós-de-classe.
        for (ClassInfo cls : fqnIndex.values()) {
            String fromId;
            if (cls.isEntity) {
                fromId = resolvedEntityNodeId(cls);
            } else if (cls.isRepository && !cls.isController && !cls.isService) {
                fromId = resolvedClassNodeId("REPOSITORY", cls);
            } else {
                continue;
            }
            if (!nodeIds.contains(fromId)) continue;
            if (cls.superClassName != null) {
                String toId = resolveOrMintSupertypeNode(cls, cls.superClassName, nodes, nodeIds);
                if (toId != null && !toId.equals(fromId)) {
                    addEdge(edges, edgeKeys, fromId, toId, "EXTENDS",
                        Map.of("resolution", "syntactic-declared"));
                }
            }
            for (String iface : cls.interfaceNames) {
                String toId = resolveOrMintSupertypeNode(cls, iface, nodes, nodeIds);
                if (toId != null && !toId.equals(fromId)) {
                    addEdge(edges, edgeKeys, fromId, toId, "IMPLEMENTS",
                        Map.of("resolution", "syntactic-declared"));
                }
            }
        }

        return new AnalysisResult(nodes, edges, resolutionErrors);
    }

    private ClassInfo resolveEntityClassForRepository(ClassInfo repoInfo) {
        if (repoInfo.resolvedEntityClassName != null) {
            return fqnIndex.values().stream()
                .filter(ci -> ci.isEntity && ci.className.equals(repoInfo.resolvedEntityClassName))
                .findFirst().orElse(null);
        }
        return null;
    }

    private void handleEntityMutations(String fromId, ClassInfo cls,
                                       List<GraphEdgeDTO> edges, Set<String> nodeIds, Set<String> edgeKeys) {
        Set<String> entityNodeIds = new HashSet<>();

        for (MethodInfo m : cls.methods) {
            for (MethodCallInfo call : m.methodCalls) {
                ClassInfo targetClass = symbolClassMap.get(call.resolvedDeclaringType);
                if (targetClass == null && call.resolvedScopeType != null) {
                    targetClass = symbolClassMap.get(call.resolvedScopeType);
                }
                // Fallback sintático (ADR-0018) — mesmo caminho do edge-loop
                if (targetClass == null && call.fallbackScopeName != null) {
                    String declaredType = cls.fieldTypes.get(call.fallbackScopeName);
                    if (declaredType != null) {
                        targetClass = resolveTypeToClassInfo(cls, declaredType);
                    }
                }
                if (targetClass != null && targetClass.isRepository) {
                    ClassInfo entityInfo = resolveEntityClassForRepository(targetClass);
                    if (entityInfo != null) {
                        entityNodeIds.add(resolvedEntityNodeId(entityInfo));
                    }
                }
            }
        }

        for (String entityNodeId : entityNodeIds) {
            if (nodeIds.contains(entityNodeId)) {
                addEdge(edges, edgeKeys, fromId, entityNodeId, "WRITES_ENTITY", Map.of("operation", "state_change", "resolution", "syntactic-declared"));
            }
        }
    }

    private String detectPersistenceOp(String methodName) {
        String lower = methodName.toLowerCase();
        for (String s : PERSISTENCE_SAVE) {
            if (lower.contains(s.toLowerCase())) return "save";
        }
        for (String d : PERSISTENCE_DELETE) {
            if (lower.contains(d.toLowerCase())) return "delete";
        }
        for (String r : PERSISTENCE_READ) {
            if (lower.contains(r.toLowerCase())) return "read";
        }
        if (lower.startsWith("find") || lower.startsWith("get") || lower.startsWith("search") ||
            lower.startsWith("query") || lower.startsWith("list") || lower.startsWith("fetch") ||
            lower.startsWith("exists") || lower.startsWith("count")) {
            return "read";
        }
        return null;
    }

    private boolean isWriteOp(String op) {
        return "save".equals(op) || "update".equals(op) || "delete".equals(op);
    }

    private void addEdge(List<GraphEdgeDTO> edges, Set<String> edgeKeys,
                         String fromNode, String toNode, String relationType,
                         Map<String, Object> metadata) {
        String key = fromNode + "->" + toNode + ":" + relationType;
        if (edgeKeys.add(key)) {
            edges.add(new GraphEdgeDTO(fromNode, toNode, relationType, metadata));
        }
    }

    static class ClassInfo {
        String className;
        String packageName;
        String fqn;
        String sourceFile;
        boolean isInterface;
        boolean isController;
        boolean isService;
        boolean isRepository;
        boolean isEntity;
        String basePath = "";
        String superClassName;
        ResolvedReferenceTypeDeclaration resolvedSymbol;
        ResolvedReferenceTypeDeclaration resolvedEntitySymbol;
        String resolvedEntityClassName;
        List<MethodInfo> methods = new ArrayList<>();
        List<EntityField> entityFields = new ArrayList<>();
        List<SecurityAnnotation> securityAnnotations = new ArrayList<>();
        // Fallback sintático (ADR-0018): tipo declarado de cada campo (DI por
        // injeção) + imports do CU — resolvem chamadas quando o SymbolSolver
        // falha em tipos externos (repo.save herdado do JpaRepository etc.).
        Map<String, String> fieldTypes = new HashMap<>();
        Map<String, String> importsSimpleToFqn = new HashMap<>();
        // Wave 2: interfaces que esta classe implementa (ou, se for interface,
        // estende) — nomes simples. Base do índice interface→impl.
        List<String> interfaceNames = new ArrayList<>();
        // Onda 3a: associações JPA [tipoAlvoSimples, kind] declaradas nos campos.
        List<String[]> entityAssociations = new ArrayList<>();
        // Onda 4: implementa CommandLineRunner/ApplicationRunner (run() = boot).
        boolean isRunner;
        // Onda 5: anotações declaradas na classe (nomes simples) — insumo do fecho.
        List<String> classAnnotationNames = new ArrayList<>();
    }

    static class MethodInfo {
        String name;
        String returnType;
        List<String> parameters = new ArrayList<>();
        // ADR-0018: tipos declarados por nome (var local do corpo + parâmetro) —
        // resolvem a ENTIDADE passada como argumento (padrão Db.save(em(), contract)).
        Map<String, String> localVarTypes = new HashMap<>();
        Map<String, String> paramTypesByName = new HashMap<>();
        String httpMethod;
        String httpPath;
        String resolvedQualifiedSignature;
        List<MethodCallInfo> methodCalls = new ArrayList<>();
        boolean hasEntityMutations;
        List<SecurityAnnotation> securityAnnotations = new ArrayList<>();
        // Onda 4: tipo do gatilho de fundo (@Scheduled/@EventListener/…), ou null.
        String entryPointKind;
        // Onda 3b: literais JPQL (@Query no método + em.createQuery no corpo).
        List<String> jpqlStrings = new ArrayList<>();
    }

    static class MethodCallInfo {
        String methodName;
        ResolvedReferenceTypeDeclaration resolvedDeclaringType;
        ResolvedReferenceTypeDeclaration resolvedScopeType;
        String resolvedSignature;
        String resolvedMethodSignature;
        String resolvedReturnType;
        // fallback sintático quando o resolve() falha (ADR-0018):
        String fallbackScopeName;      // nome simples do escopo (campo/variável) ou null
        boolean fallbackUnqualified;   // chamada sem escopo (helper da própria classe)
        int argCount = -1;
        List<String> argNames = new ArrayList<>();        // args NameExpr (variáveis)
        List<String> argClassLiterals = new ArrayList<>(); // args X.class
    }

    static class EntityField {
        String name;
        String type;
        boolean isId;
        List<String> validationAnnotations = new ArrayList<>();
        boolean isSensitive;
    }

    static class SecurityAnnotation {
        String type;
        String expression;
        List<String> roles = new ArrayList<>();

        SecurityAnnotation(String type, String expression, List<String> roles) {
            this.type = type;
            this.expression = expression;
            this.roles = roles != null ? roles : new ArrayList<>();
        }
    }
}
