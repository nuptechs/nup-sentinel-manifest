import _ts from "typescript";

import ts = _ts;

export class ImportedHttpClients {
  private httpIdentifiers = new Set<string>();
  private fetchIdentifier = "fetch";
  private importSources = new Set<string>();

  static build(sourceFile: ts.SourceFile): ImportedHttpClients {
    const clients = new ImportedHttpClients();
    clients.indexImports(sourceFile);
    return clients;
  }

  private indexImports(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const source = node.moduleSpecifier.text.toLowerCase();
        this.importSources.add(source);

        const httpModules = ["axios", "@angular/common/http", "@angular/http", "ky", "got", "superagent", "request", "wretch"];
        const isHttpModule = httpModules.some(m => source === m || source.startsWith(m + "/"));

        if (isHttpModule && node.importClause) {
          if (node.importClause.name) {
            this.httpIdentifiers.add(node.importClause.name.text);
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const spec of node.importClause.namedBindings.elements) {
                this.httpIdentifiers.add(spec.name.text);
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              this.httpIdentifiers.add(node.importClause.namedBindings.name.text);
            }
          }
        }

        if (source.includes("api") || source.includes("http") || source.includes("request") || source.includes("service")) {
          if (node.importClause) {
            if (node.importClause.name) {
              this.httpIdentifiers.add(node.importClause.name.text);
            }
            if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
              for (const spec of node.importClause.namedBindings.elements) {
                const lowerName = spec.name.text.toLowerCase();
                if (lowerName.includes("api") || lowerName.includes("http") ||
                    lowerName.includes("request") || lowerName.includes("client") ||
                    lowerName.includes("instance")) {
                  this.httpIdentifiers.add(spec.name.text);
                }
              }
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isCallExpression(node.initializer)) {
          const callText = node.initializer.expression;
          if (ts.isPropertyAccessExpression(callText) && callText.name.text === "create") {
            const obj = callText.expression;
            if (ts.isIdentifier(obj) && this.httpIdentifiers.has(obj.text)) {
              this.httpIdentifiers.add(node.name.text);
            }
          }
          if (ts.isIdentifier(callText) && this.httpIdentifiers.has(callText.text)) {
            this.httpIdentifiers.add(node.name.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  isHttpClient(identifierText: string): boolean {
    if (this.httpIdentifiers.has(identifierText)) return true;
    if (identifierText === "fetch") return true;
    const lower = identifierText.toLowerCase();
    if (lower === "axios" || lower === "ky" || lower === "got" || lower === "superagent" || lower === "wretch") return true;
    return false;
  }

  isHttpExpression(expressionText: string): boolean {
    const lower = expressionText.toLowerCase();
    if (this.httpIdentifiers.has(expressionText)) return true;
    const idArray = Array.from(this.httpIdentifiers);
    for (let i = 0; i < idArray.length; i++) {
      if (lower === idArray[i].toLowerCase()) return true;
      if (lower.endsWith("." + idArray[i].toLowerCase())) return true;
    }
    if (lower === "this.http" || lower === "this.$http" || lower === "this.httpclient") return true;
    return false;
  }
}
