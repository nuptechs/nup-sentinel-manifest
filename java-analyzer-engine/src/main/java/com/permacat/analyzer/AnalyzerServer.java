package com.permacat.analyzer;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.permacat.model.AnalysisResult;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;

import java.io.*;
import java.lang.reflect.Type;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class AnalyzerServer {

    private static final Gson gson = new Gson();
    private static final int PORT = 9876;

    public static void main(String[] args) throws IOException {
        int port = PORT;
        if (args.length > 0) {
            try {
                port = Integer.parseInt(args[0]);
            } catch (NumberFormatException e) {
                System.err.println("Invalid port, using default: " + PORT);
            }
        }

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);

        server.createContext("/analyze", exchange -> {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                handleAnalyze(exchange);
            } else {
                sendResponse(exchange, 405, "{\"error\":\"Method not allowed\"}");
            }
        });

        server.createContext("/health", exchange -> {
            sendResponse(exchange, 200, "{\"status\":\"ok\"}");
        });

        server.setExecutor(null);
        server.start();
        System.out.println("Java Analyzer Engine running on port " + port);
    }

    private static void handleAnalyze(HttpExchange exchange) throws IOException {
        try {
            String body = readBody(exchange);

            Type mapType = new TypeToken<Map<String, String>>(){}.getType();
            Map<String, String> files = gson.fromJson(body, mapType);

            if (files == null || files.isEmpty()) {
                sendResponse(exchange, 400, "{\"error\":\"No files provided\"}");
                return;
            }

            System.out.println("[java-engine] Received " + files.size() + " Java files for analysis");
            long analysisStart = System.currentTimeMillis();

            JavaASTAnalyzer analyzer = new JavaASTAnalyzer();
            AnalysisResult result = analyzer.analyze(files);

            long analysisDuration = System.currentTimeMillis() - analysisStart;
            System.out.println("[java-engine] Analysis complete in " + (analysisDuration / 1000.0) + "s — "
                + result.nodes.size() + " nodes, " + result.edges.size() + " edges"
                + (result.resolutionErrors != null ? ", " + result.resolutionErrors.size() + " resolution errors" : ""));

            long serializeStart = System.currentTimeMillis();
            String json = gson.toJson(result);
            System.out.println("[java-engine] JSON serialization: " + (System.currentTimeMillis() - serializeStart) + "ms, " + (json.length() / 1024) + " KB");
            sendResponse(exchange, 200, json);
        } catch (Exception e) {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            String errorJson = gson.toJson(Map.of(
                "error", e.getMessage() != null ? e.getMessage() : "Unknown error",
                "stackTrace", sw.toString()
            ));
            sendResponse(exchange, 500, errorJson);
        }
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream is = exchange.getRequestBody();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            return sb.toString();
        }
    }

    private static void sendResponse(HttpExchange exchange, int statusCode, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(statusCode, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
