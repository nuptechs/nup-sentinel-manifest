package com.permacat.model;

import java.util.ArrayList;
import java.util.List;

public class AnalysisResult {
    public List<GraphNodeDTO> nodes;
    public List<GraphEdgeDTO> edges;
    public List<String> resolutionErrors;

    public AnalysisResult(List<GraphNodeDTO> nodes, List<GraphEdgeDTO> edges, List<String> resolutionErrors) {
        this.nodes = nodes;
        this.edges = edges;
        this.resolutionErrors = resolutionErrors != null ? resolutionErrors : new ArrayList<>();
    }
}
