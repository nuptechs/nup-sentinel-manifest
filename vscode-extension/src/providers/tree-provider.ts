import * as vscode from "vscode";

interface TreeEntry {
  label: string;
  description?: string;
  tooltip?: string;
  filePath?: string;
  line?: number;
  iconId?: string;
  children?: TreeEntry[];
}

export class ManifestTreeProvider implements vscode.TreeDataProvider<TreeEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private screens: TreeEntry[] = [];
  private endpoints: TreeEntry[] = [];
  private security: TreeEntry[] = [];

  setData(result: any): void {
    this.screens = [];
    this.endpoints = [];
    this.security = [];

    if (result?.interactions) {
      const byFile = new Map<string, TreeEntry[]>();
      for (const item of result.interactions) {
        const file = item.filePath || item.file || "unknown";
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push({
          label: item.handlerName || item.handler || "unknown",
          description: `${item.eventType || ""} (line ${item.line || "?"})`,
          tooltip: `${item.framework || ""} | ${item.httpMethod || ""} ${item.httpUrl || ""}`.trim(),
          filePath: file,
          line: item.line,
          iconId: item.httpMethod ? "globe" : "zap",
        });
      }

      for (const [file, children] of byFile) {
        const shortName = file.split("/").pop() || file;
        this.screens.push({
          label: shortName,
          description: `${children.length} interaction(s)`,
          tooltip: file,
          iconId: "file-code",
          children,
        });
      }
    }

    if (result?.endpoints) {
      for (const ep of result.endpoints) {
        this.endpoints.push({
          label: `${ep.method || "GET"} ${ep.path || ep.url || ""}`,
          description: ep.controller || ep.handler || "",
          tooltip: `Criticality: ${ep.criticality || "unknown"}`,
          filePath: ep.filePath,
          line: ep.line,
          iconId: this.methodIcon(ep.method),
        });
      }
    }

    if (result?.security) {
      for (const sec of result.security) {
        this.security.push({
          label: sec.issue || sec.label || "Security Issue",
          description: sec.severity || sec.criticality || "medium",
          tooltip: sec.details || sec.description || "",
          filePath: sec.filePath,
          line: sec.line,
          iconId: sec.severity === "high" || sec.criticality === "high" ? "warning" : "info",
        });
      }
    }

    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.screens = [];
    this.endpoints = [];
    this.security = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeEntry): vscode.TreeItem {
    const hasChildren = element.children && element.children.length > 0;
    const item = new vscode.TreeItem(
      element.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    item.description = element.description;
    item.tooltip = element.tooltip;
    item.iconPath = element.iconId ? new vscode.ThemeIcon(element.iconId) : undefined;

    if (element.filePath && element.line) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [
          vscode.Uri.file(element.filePath),
          { selection: new vscode.Range(element.line - 1, 0, element.line - 1, 0) },
        ],
      };
    }

    return item;
  }

  getChildren(element?: TreeEntry): vscode.ProviderResult<TreeEntry[]> {
    if (!element) {
      const roots: TreeEntry[] = [];
      roots.push({
        label: "Screens",
        description: `${this.screens.length} file(s)`,
        iconId: "window",
        children: this.screens,
      });
      roots.push({
        label: "Endpoints",
        description: `${this.endpoints.length} endpoint(s)`,
        iconId: "server",
        children: this.endpoints,
      });
      roots.push({
        label: "Security",
        description: `${this.security.length} issue(s)`,
        iconId: "shield",
        children: this.security,
      });
      return roots;
    }

    return element.children || [];
  }

  private methodIcon(method?: string): string {
    switch (method?.toUpperCase()) {
      case "GET": return "arrow-down";
      case "POST": return "arrow-up";
      case "PUT": return "edit";
      case "DELETE": return "trash";
      case "PATCH": return "pencil";
      default: return "globe";
    }
  }
}
