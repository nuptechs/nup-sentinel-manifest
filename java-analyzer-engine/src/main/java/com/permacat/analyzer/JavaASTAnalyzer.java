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

    private final SymbolMap symbolClassMap = new SymbolMap();
    private final Map<String, ClassInfo> fqnIndex = new HashMap<>();

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
        try {
            tempDir = writeFilesToTemp(files);
            JavaParser parser = configureParserWithSymbolSolver(tempDir);

            List<CompilationUnit> compilationUnits = new ArrayList<>();
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
                        String problems = result.getProblems().stream()
                            .map(p -> p.getMessage())
                            .collect(Collectors.joining("; "));
                        String msg = "Parse error in " + filePath + ": " + problems;
                        System.err.println(msg);
                        resolutionErrors.add(msg);
                    }
                } catch (Exception e) {
                    String msg = "Failed to parse " + filePath + ": " + e.getMessage();
                    System.err.println(msg);
                    resolutionErrors.add(msg);
                }
            }

            resolveClassSymbols(compilationUnits, resolutionErrors);
            resolveMethodSignatures(compilationUnits, resolutionErrors);
            resolveRepositoryEntitiesViaGenerics(compilationUnits, resolutionErrors);

        } catch (Exception e) {
            System.err.println("Symbol solver init failed: " + e.getMessage());
            resolutionErrors.add("Symbol solver init failed: " + e.getMessage());
        } finally {
            if (tempDir != null) {
                deleteRecursively(tempDir.toFile());
            }
        }

        return buildGraph(resolutionErrors);
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

            info.isController = annotations.stream().anyMatch(CONTROLLER_ANNOTATIONS::contains);
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

            String classLevelPath = "";
            for (AnnotationExpr ann : cls.getAnnotations()) {
                if (ann.getNameAsString().equals("RequestMapping")) {
                    classLevelPath = extractMappingPath(ann);
                }
            }
            info.basePath = classLevelPath;

            if (info.isEntity) {
                extractEntityFields(cls, info);
            }

            extractMethods(cls, info);

            fqnIndex.put(info.fqn, info);
        }
    }

    private void extractEntityFields(ClassOrInterfaceDeclaration cls, ClassInfo info) {
        for (FieldDeclaration field : cls.getFields()) {
            for (VariableDeclarator var : field.getVariables()) {
                EntityField ef = new EntityField();
                ef.name = var.getNameAsString();
                ef.type = var.getTypeAsString();
                ef.isId = field.getAnnotations().stream()
                    .anyMatch(a -> a.getNameAsString().equals("Id") || a.getNameAsString().equals("EmbeddedId"));
                info.entityFields.add(ef);
            }
        }
    }

    private void extractMethods(ClassOrInterfaceDeclaration cls, ClassInfo info) {
        for (MethodDeclaration method : cls.getMethods()) {
            MethodInfo mi = new MethodInfo();
            mi.name = method.getNameAsString();
            mi.returnType = method.getTypeAsString();
            mi.parameters = method.getParameters().stream()
                .map(p -> p.getTypeAsString() + " " + p.getNameAsString())
                .collect(Collectors.toList());

            for (AnnotationExpr ann : method.getAnnotations()) {
                String annName = ann.getNameAsString();
                if (MAPPING_ANNOTATIONS.contains(annName)) {
                    mi.httpMethod = resolveHttpMethod(annName, ann);
                    String methodPath = extractMappingPath(ann);
                    mi.httpPath = combinePaths(info.basePath, methodPath);
                    break;
                }
            }

            if (method.getBody().isPresent()) {
                BlockStmt body = method.getBody().get();
                extractMethodCalls(body, mi);
                detectEntityMutations(body, mi);
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
                }
            }
        }, null);
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

    private AnalysisResult buildGraph(List<String> resolutionErrors) {
        List<GraphNodeDTO> nodes = new ArrayList<>();
        List<GraphEdgeDTO> edges = new ArrayList<>();
        Set<String> nodeIds = new HashSet<>();
        Set<String> edgeKeys = new HashSet<>();
        Map<String, String> signatureToNodeId = new HashMap<>();

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
                if (nodeIds.add(entityNode.id)) {
                    nodes.add(entityNode);
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
                            Map.of("operation", "read"));
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

                for (MethodCallInfo call : method.methodCalls) {
                    ClassInfo targetClass = symbolClassMap.get(call.resolvedDeclaringType);
                    if (targetClass == null && call.resolvedScopeType != null) {
                        targetClass = symbolClassMap.get(call.resolvedScopeType);
                    }

                    if (targetClass == null) continue;

                    if (targetClass.isRepository) {
                        String repoQualifiedName = targetClass.resolvedSymbol != null
                            ? targetClass.resolvedSymbol.getQualifiedName() : targetClass.fqn;
                        String requalified = requalifySignature(call.resolvedSignature, repoQualifiedName);
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
                                        addEdge(edges, edgeKeys, repoMethodNodeId, entityNodeId, "WRITES_ENTITY", Map.of("operation", op));
                                    } else {
                                        addEdge(edges, edgeKeys, repoMethodNodeId, entityNodeId, "READS_ENTITY", Map.of("operation", op != null ? op : "read"));
                                    }
                                }
                            }
                        }
                        addEdge(edges, edgeKeys, fromId, repoMethodNodeId, "CALLS", null);
                    } else {
                        String targetQualifiedName = targetClass.resolvedSymbol != null
                            ? targetClass.resolvedSymbol.getQualifiedName() : targetClass.fqn;
                        String requalified = requalifySignature(call.resolvedSignature, targetQualifiedName);
                        String toId = signatureToNodeId.get(requalified);

                        if (toId == null) {
                            toId = signatureToNodeId.get(call.resolvedSignature);
                        }

                        if (toId != null && nodeIds.contains(toId)) {
                            addEdge(edges, edgeKeys, fromId, toId, "CALLS", null);
                        }
                    }
                }

                if (method.hasEntityMutations) {
                    handleEntityMutations(fromId, cls, edges, nodeIds, edgeKeys);
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
                addEdge(edges, edgeKeys, fromId, entityNodeId, "WRITES_ENTITY", Map.of("operation", "state_change"));
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
        ResolvedReferenceTypeDeclaration resolvedSymbol;
        ResolvedReferenceTypeDeclaration resolvedEntitySymbol;
        String resolvedEntityClassName;
        List<MethodInfo> methods = new ArrayList<>();
        List<EntityField> entityFields = new ArrayList<>();
    }

    static class MethodInfo {
        String name;
        String returnType;
        List<String> parameters = new ArrayList<>();
        String httpMethod;
        String httpPath;
        String resolvedQualifiedSignature;
        List<MethodCallInfo> methodCalls = new ArrayList<>();
        boolean hasEntityMutations;
    }

    static class MethodCallInfo {
        String methodName;
        ResolvedReferenceTypeDeclaration resolvedDeclaringType;
        ResolvedReferenceTypeDeclaration resolvedScopeType;
        String resolvedSignature;
        String resolvedMethodSignature;
        String resolvedReturnType;
    }

    static class EntityField {
        String name;
        String type;
        boolean isId;
    }
}
