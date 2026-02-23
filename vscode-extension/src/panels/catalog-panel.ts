import * as vscode from "vscode";

export class CatalogPanel {
  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  show(data: any): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "permacatCatalog",
        "PermaCat Catalog",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.webview.html = this.getHtml(data);
  }

  update(data: any): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: "update", data });
    }
  }

  private getHtml(data: any): string {
    const interactions = data?.interactions || [];
    const endpoints = data?.endpoints || [];
    const security = data?.security || [];

    const totalInteractions = interactions.length;
    const totalEndpoints = endpoints.length;

    const interactionsWithEndpoints = interactions.filter(
      (i: any) => i.httpUrl || i.httpMethod
    ).length;
    const coveragePercent =
      totalInteractions > 0
        ? Math.round((interactionsWithEndpoints / totalInteractions) * 100)
        : 0;

    const criticalityValues = interactions
      .map((i: any) => {
        const c = (i.criticality || "").toLowerCase();
        if (c === "critical" || c === "high") return 3;
        if (c === "medium") return 2;
        if (c === "low") return 1;
        return 0;
      })
      .filter((v: number) => v > 0);

    const avgCriticality =
      criticalityValues.length > 0
        ? (criticalityValues.reduce((a: number, b: number) => a + b, 0) / criticalityValues.length).toFixed(1)
        : "N/A";

    const interactionRows = interactions
      .map(
        (i: any) => `
        <tr>
          <td>${this.escape(i.handlerName || i.handler || "")}</td>
          <td>${i.httpMethod ? `<span class="badge method-${(i.httpMethod || "").toLowerCase()}">${this.escape(i.httpMethod)}</span> ${this.escape(i.httpUrl || "")}` : "<span class='muted'>-</span>"}</td>
          <td>${this.escape(i.eventType || "")}</td>
          <td><span class="badge criticality-${(i.criticality || "low").toLowerCase()}">${this.escape(i.criticality || "low")}</span></td>
          <td>${i.security || i.securityAnnotation ? this.escape(i.security || i.securityAnnotation) : "<span class='muted'>none</span>"}</td>
        </tr>`
      )
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PermaCat Catalog</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    margin: 0;
  }
  h1 { font-size: 1.4em; margin: 0 0 16px 0; }
  .summary {
    display: flex;
    gap: 24px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .stat {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 4px;
    padding: 12px 20px;
    text-align: center;
    min-width: 120px;
  }
  .stat-value {
    font-size: 1.8em;
    font-weight: bold;
    color: var(--vscode-textLink-foreground);
  }
  .stat-label {
    font-size: 0.85em;
    opacity: 0.7;
    margin-top: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 2px solid var(--vscode-editorWidget-border);
    font-weight: 600;
    position: sticky;
    top: 0;
  }
  td {
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    vertical-align: top;
  }
  tr:hover td {
    background: var(--vscode-list-hoverBackground);
  }
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
  }
  .method-get { background: rgba(0, 180, 0, 0.2); color: #4caf50; }
  .method-post { background: rgba(0, 120, 255, 0.2); color: #42a5f5; }
  .method-put { background: rgba(255, 160, 0, 0.2); color: #ffa726; }
  .method-delete { background: rgba(255, 60, 60, 0.2); color: #ef5350; }
  .method-patch { background: rgba(180, 0, 255, 0.2); color: #ab47bc; }
  .criticality-high, .criticality-critical { background: rgba(255, 0, 0, 0.2); color: #ef5350; }
  .criticality-medium { background: rgba(255, 200, 0, 0.2); color: #ffa726; }
  .criticality-low { background: rgba(0, 200, 0, 0.2); color: #66bb6a; }
  .muted { opacity: 0.4; }
  .empty { text-align: center; padding: 40px; opacity: 0.5; }
</style>
</head>
<body>
  <h1>PermaCat Catalog</h1>
  <div class="summary">
    <div class="stat">
      <div class="stat-value">${totalInteractions}</div>
      <div class="stat-label">Interactions</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalEndpoints}</div>
      <div class="stat-label">Endpoints</div>
    </div>
    <div class="stat">
      <div class="stat-value">${coveragePercent}%</div>
      <div class="stat-label">Coverage</div>
    </div>
    <div class="stat">
      <div class="stat-value">${avgCriticality}</div>
      <div class="stat-label">Avg Criticality</div>
    </div>
  </div>
  ${
    totalInteractions > 0
      ? `<table>
    <thead>
      <tr>
        <th>Interaction</th>
        <th>Endpoint</th>
        <th>Operation</th>
        <th>Criticality</th>
        <th>Security</th>
      </tr>
    </thead>
    <tbody>${interactionRows}</tbody>
  </table>`
      : `<div class="empty">No interactions found. Run an analysis first.</div>`
  }
  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener("message", (event) => {
      if (event.data.type === "update") {
        vscode.postMessage({ type: "refresh" });
      }
    });
  </script>
</body>
</html>`;
  }

  private escape(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
