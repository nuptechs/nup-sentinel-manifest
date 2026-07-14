// ─────────────────────────────────────────────
// Captura HTTP do template rest-express — ADR-0015 Onda 1, D6.
//
// O template rest-express (o mesmo scaffold Vue/React deste projeto) esconde a
// URL da chamada em dois lugares que o extrator HTTP genérico não enxerga:
//   1. useQuery({ queryKey: ["/easynup/findContracts.v1"] }) — a URL é o
//      queryKey; não há fetch/axios no call-site (o fetcher é global).
//   2. apiRequest("POST", "/easynup/x.v1") — wrapper (method, url) do template.
// Estes viram FrontendInteraction HTTP, resolvidas contra o backend pelo mesmo
// matchUrlToEndpoint das chamadas normais.
//
// Vive atrás da flag MANIFEST_MULTISTACK_HTTP_TEMPLATE (frontendHttpTemplate).
// DEFAULT OFF ⇒ ninguém invoca este módulo ⇒ pipeline byte-a-byte (G2). ON ⇒
// SUPERSET estrito: só ENTRA interação nova (G3). Canário: o useQuery em
// Contracts.vue vira interação GET /easynup/findContracts.v1.
//
// Regex determinística, sem AST (espelha o parser de rotas Express do D1).
// ─────────────────────────────────────────────

import type { ApplicationGraph } from "../application-graph";
import type { FrontendInteraction } from "../frontend-analyzer";
import { getComponentName, matchUrlToEndpoint } from "./utils";

// useQuery({ ... queryKey: ["/url", ...] ... }) — 1ª string do array que é URL.
const USE_QUERY_RE =
  /useQuery\s*\(\s*\{[^{}]*?queryKey\s*:\s*\[\s*(['"`])(\/[^'"`]*)\1/g;

// const/let/var NOME = useQuery(  — pra nomear a interação com a variável.
const QUERY_VAR_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useQuery\s*\(/g;

// apiRequest("METHOD", "/url")  ou  apiRequest("/url")  (GET implícito).
const API_REQUEST_RE =
  /apiRequest\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*(['"`])([^'"`]+)\3)?/g;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Mapeia índice→nome da variável do useQuery mais próximo antes dele (ou null). */
function queryVarBefore(content: string, matchIdx: number): string | null {
  QUERY_VAR_RE.lastIndex = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = QUERY_VAR_RE.exec(content)) !== null) {
    if (m.index <= matchIdx) best = m[1];
    else break;
  }
  return best;
}

function makeInteraction(
  component: string,
  actionName: string,
  elementType: string,
  httpMethod: string,
  url: string,
  sourceFile: string,
  lineNumber: number,
  graph: ApplicationGraph,
): FrontendInteraction {
  const backendNode = matchUrlToEndpoint(httpMethod, url, graph);
  const resolutionPath = [
    {
      tier: "local",
      file: sourceFile,
      function: actionName,
      detail: "rest-express template (D6): queryKey/apiRequest",
    },
    ...(backendNode
      ? [
          {
            tier: "controller",
            file: backendNode.className,
            function: backendNode.methodName,
            detail: `matched ${httpMethod} ${url} (rest-express template)`,
          },
        ]
      : []),
  ];

  return {
    component,
    elementType,
    actionName,
    httpMethod,
    url,
    mappedBackendNode: backendNode,
    sourceFile,
    lineNumber,
    resolutionTier: backendNode ? "controller" : "local",
    resolutionStrategy: "rest-express-template",
    resolutionPath,
    interactionCategory: "HTTP",
    confidence: 1.0,
  };
}

/**
 * Extrai as interações HTTP escondidas no template rest-express (queryKey e
 * apiRequest) e as resolve contra o backend. Determinístico, ordenado por
 * (arquivo, linha). Só non-.java com "useQuery"/"apiRequest" no conteúdo.
 */
export function extractRestExpressInteractions(
  files: { filePath: string; content: string }[],
  graph: ApplicationGraph,
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];

  for (const file of files) {
    if (file.filePath.endsWith(".java")) continue;
    const content = file.content;
    const hasQuery = content.includes("useQuery");
    const hasApiRequest = content.includes("apiRequest");
    if (!hasQuery && !hasApiRequest) continue;

    const component = getComponentName(file.filePath);

    if (hasQuery) {
      USE_QUERY_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = USE_QUERY_RE.exec(content)) !== null) {
        const url = m[2];
        const varName = queryVarBefore(content, m.index);
        interactions.push(
          makeInteraction(
            component,
            varName || "useQuery",
            "query",
            "GET",
            url,
            file.filePath,
            lineAt(content, m.index),
            graph,
          ),
        );
      }
    }

    if (hasApiRequest) {
      API_REQUEST_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = API_REQUEST_RE.exec(content)) !== null) {
        const arg1 = m[2];
        const arg2 = m[4];
        let method: string;
        let url: string;
        if (arg2) {
          method = arg1.toUpperCase();
          url = arg2;
        } else if (arg1.startsWith("/")) {
          method = "GET";
          url = arg1;
        } else {
          continue; // apiRequest(algoQueNãoÉURL) sem 2º arg — ignora.
        }
        interactions.push(
          makeInteraction(
            component,
            "apiRequest",
            "api-request",
            method,
            url,
            file.filePath,
            lineAt(content, m.index),
            graph,
          ),
        );
      }
    }
  }

  interactions.sort((a, b) =>
    `${a.sourceFile}:${a.lineNumber}`.localeCompare(`${b.sourceFile}:${b.lineNumber}`),
  );
  return interactions;
}
