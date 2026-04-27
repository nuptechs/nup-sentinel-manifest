export function getOpenAPISpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Manifest API",
      version: "1.0.0",
      description: "Code-to-Permission Catalog Generator API. Analyze frontend (Vue/React/Angular) and Spring Boot backend source code to automatically generate Technical Action Catalogs for IAM systems.",
      contact: { name: "Manifest" },
    },
    servers: [
      { url: "/", description: "Current server" },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/analyze": {
        post: {
          tags: ["Headless Analysis"],
          summary: "Analyze source files (headless)",
          description: "Single-call endpoint: send source files, get back analysis results + manifest. No project management needed.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["files"],
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["path", "content"],
                        properties: {
                          path: { type: "string", example: "src/main/java/com/app/UserController.java" },
                          content: { type: "string", example: "@RestController..." },
                        },
                      },
                    },
                    options: {
                      type: "object",
                      properties: {
                        format: { type: "string", enum: ["manifest", "agents-md", "openapi", "policy-matrix", "keycloak-realm", "opa-rego", "compliance-report", "all"], default: "manifest" },
                        projectName: { type: "string", default: "headless-<timestamp>" },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Analysis results with manifest",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/analyze-zip": {
        post: {
          tags: ["Headless Analysis"],
          summary: "Analyze ZIP file (headless)",
          description: "Upload a ZIP file containing source code for analysis. Returns analysis results + manifest.",
          parameters: [
            { name: "format", in: "query", schema: { type: "string", enum: ["manifest", "agents-md", "openapi", "policy-matrix", "keycloak-realm", "opa-rego", "compliance-report", "all"] } },
          ],
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" }, name: { type: "string" } } } } },
          },
          responses: { 200: { description: "Analysis results with manifest" } },
        },
      },
      "/api/projects": {
        get: {
          tags: ["Projects"],
          summary: "List all projects",
          responses: { 200: { description: "Array of projects" } },
        },
        post: {
          tags: ["Projects"],
          summary: "Create a new project with files",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    files: { type: "array", items: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } } } },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Created project with analysis result" } },
        },
      },
      "/api/projects/{id}": {
        get: {
          tags: ["Projects"],
          summary: "Get project details",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Project details" } },
        },
        delete: {
          tags: ["Projects"],
          summary: "Delete a project",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Project deleted" } },
        },
      },
      "/api/projects/{id}/analyze": {
        post: {
          tags: ["Analysis"],
          summary: "Re-analyze an existing project",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Analysis result (SSE stream)", content: { "text/event-stream": {} } } },
        },
      },
      "/api/catalog-entries/{projectId}": {
        get: {
          tags: ["Catalog"],
          summary: "Get catalog entries for a project",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Array of catalog entries" } },
        },
      },
      "/api/catalog-entries/{id}": {
        patch: {
          tags: ["Catalog"],
          summary: "Update a catalog entry (human classification)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { humanClassification: { type: "string" } } } } },
          },
          responses: { 200: { description: "Updated entry" } },
        },
      },
      "/api/manifest/{projectId}": {
        get: {
          tags: ["Manifests"],
          summary: "Generate manifest in specified format",
          description: "Supports 7 output formats: manifest (JSON), agents-md (Markdown), openapi (OpenAPI 3.0), policy-matrix (Keycloak/Okta/AWS IAM), keycloak-realm (importable Keycloak realm JSON), opa-rego (OPA/Rego policy), compliance-report (SOC2/LGPD HTML audit report).",
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "integer" } },
            { name: "format", in: "query", schema: { type: "string", enum: ["manifest", "agents-md", "openapi", "policy-matrix", "keycloak-realm", "opa-rego", "compliance-report", "all"] }, description: "Output format" },
            { name: "bundle", in: "query", schema: { type: "string", enum: ["true"] }, description: "For opa-rego format: return OPA bundle as JSON instead of raw .rego text" },
          ],
          responses: { 200: { description: "Manifest in requested format" } },
        },
      },
      "/api/projects/{projectId}/diff": {
        get: {
          tags: ["Diff"],
          summary: "Compare two analysis runs",
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "integer" } },
            { name: "runA", in: "query", required: true, schema: { type: "integer" } },
            { name: "runB", in: "query", required: true, schema: { type: "integer" } },
          ],
          responses: { 200: { description: "Manifest diff between two runs" } },
        },
      },
      "/api/projects/{projectId}/diff/latest": {
        get: {
          tags: ["Diff"],
          summary: "Compare last two analysis runs",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Manifest diff between last two runs" } },
        },
      },
      "/api/projects/{projectId}/snapshots": {
        get: {
          tags: ["Diff"],
          summary: "List analysis snapshots",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Array of snapshots" } },
        },
      },
      "/api/projects/{projectId}/git/connect": {
        post: {
          tags: ["Git Integration"],
          summary: "Connect project to a Git repository",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["provider", "repoUrl", "token"],
                  properties: {
                    provider: { type: "string", enum: ["github", "gitlab"] },
                    repoUrl: { type: "string", format: "uri" },
                    token: { type: "string" },
                    defaultBranch: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Repository connected" } },
        },
      },
      "/api/projects/{projectId}/git/branches": {
        get: {
          tags: ["Git Integration"],
          summary: "List branches of connected repository",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Array of branches" } },
        },
      },
      "/api/projects/{projectId}/git/pull-requests": {
        get: {
          tags: ["Git Integration"],
          summary: "List pull requests / merge requests",
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "integer" } },
            { name: "state", in: "query", schema: { type: "string", enum: ["open", "closed", "all"] } },
          ],
          responses: { 200: { description: "Array of pull requests" } },
        },
      },
      "/api/projects/{projectId}/analyze-branch": {
        post: {
          tags: ["Git Integration"],
          summary: "Fetch and analyze a branch (SSE)",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { branch: { type: "string" } } } } } },
          responses: { 200: { description: "SSE stream with analysis progress", content: { "text/event-stream": {} } } },
        },
      },
      "/api/projects/{projectId}/analyze-pr": {
        post: {
          tags: ["Git Integration"],
          summary: "Analyze a PR with dual-branch comparison",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["prNumber"], properties: { prNumber: { type: "integer" } } } } },
          },
          responses: { 200: { description: "SSE stream with PR analysis and manifest diff", content: { "text/event-stream": {} } } },
        },
      },
      "/api/projects/{projectId}/git/status": {
        get: {
          tags: ["Git Integration"],
          summary: "Get Git connection status",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Git connection status" } },
        },
      },
      "/api/projects/{projectId}/git/disconnect": {
        delete: {
          tags: ["Git Integration"],
          summary: "Disconnect Git repository",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Repository disconnected" } },
        },
      },
      "/api/keys": {
        get: {
          tags: ["API Keys"],
          summary: "List API keys",
          responses: { 200: { description: "Array of API keys (without secrets)" } },
        },
        post: {
          tags: ["API Keys"],
          summary: "Create a new API key",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", example: "CI Pipeline" },
                    projectScope: { type: "integer", description: "Restrict to a specific project ID", nullable: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Created API key with raw secret (shown only once)" } },
        },
      },
      "/api/keys/{id}": {
        delete: {
          tags: ["API Keys"],
          summary: "Revoke an API key",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "API key revoked" } },
        },
      },
      "/api/projects/{projectId}/security-findings": {
        get: {
          tags: ["Security"],
          summary: "Get security findings for a project",
          description: "Returns security omission findings from the latest analysis run (or a specific run). Detects unprotected outliers, privilege escalation risks, inconsistent protection, and coverage gaps.",
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "integer" } },
            { name: "runId", in: "query", schema: { type: "integer" }, description: "Specific analysis run ID. Defaults to latest completed run." },
          ],
          responses: { 200: { description: "Array of security findings with evidence and recommendations" } },
        },
      },
      "/api/projects/{id}/webhook/configure": {
        post: {
          tags: ["Webhooks"],
          summary: "Configure webhook for a project",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    webhookSecret: { type: "string", description: "Secret for webhook signature verification" },
                    webhookEnabled: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Webhook configured" } },
        },
      },
      "/api/webhook/github": {
        post: {
          tags: ["Webhooks"],
          summary: "GitHub webhook receiver",
          description: "Receives GitHub PR events. Verifies X-Hub-Signature-256 header. Only processes 'pull_request' events with 'opened' or 'synchronize' actions.",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Webhook received" } },
        },
      },
      "/api/webhook/gitlab": {
        post: {
          tags: ["Webhooks"],
          summary: "GitLab webhook receiver",
          description: "Receives GitLab MR events. Verifies X-Gitlab-Token header. Only processes 'merge_request' events with 'open' or 'update' actions.",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Webhook received" } },
        },
      },
      "/api/stats": {
        get: {
          tags: ["System"],
          summary: "Get system statistics",
          responses: { 200: { description: "System stats" } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key authentication. Use your API key as the bearer token: `Authorization: Bearer pk_...`",
        },
      },
    },
    tags: [
      { name: "Headless Analysis", description: "Single-call analysis endpoints for CI/CD and external integrations" },
      { name: "Projects", description: "Project management" },
      { name: "Analysis", description: "Analysis pipeline operations" },
      { name: "Catalog", description: "Catalog entry management" },
      { name: "Manifests", description: "Manifest generation in multiple formats" },
      { name: "Diff", description: "Manifest diff and snapshot comparison" },
      { name: "Git Integration", description: "GitHub and GitLab repository integration" },
      { name: "Security", description: "Security omission detection and findings" },
      { name: "API Keys", description: "API key management" },
      { name: "Webhooks", description: "GitHub and GitLab webhook receivers for automated PR analysis" },
      { name: "System", description: "System-level endpoints" },
    ],
  };
}
