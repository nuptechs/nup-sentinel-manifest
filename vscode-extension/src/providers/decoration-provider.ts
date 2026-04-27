import * as vscode from "vscode";

export class ManifestDecorationProvider {
  private highCriticalityType: vscode.TextEditorDecorationType;
  private mediumCriticalityType: vscode.TextEditorDecorationType;
  private lowCriticalityType: vscode.TextEditorDecorationType;
  private securityAnnotationType: vscode.TextEditorDecorationType;

  constructor() {
    this.highCriticalityType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 0, 0, 0.15)",
      overviewRulerColor: "red",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: "rgba(255, 80, 80, 0.9)",
        fontStyle: "italic",
        margin: "0 0 0 1em",
      },
    });

    this.mediumCriticalityType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 200, 0, 0.1)",
      overviewRulerColor: "yellow",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: "rgba(200, 170, 0, 0.9)",
        fontStyle: "italic",
        margin: "0 0 0 1em",
      },
    });

    this.lowCriticalityType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(0, 200, 0, 0.08)",
      overviewRulerColor: "green",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: "rgba(80, 180, 80, 0.9)",
        fontStyle: "italic",
        margin: "0 0 0 1em",
      },
    });

    this.securityAnnotationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(0, 100, 255, 0.1)",
      overviewRulerColor: "blue",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: "rgba(80, 140, 255, 0.9)",
        fontStyle: "italic",
        margin: "0 0 0 1em",
      },
    });
  }

  updateDecorations(editor: vscode.TextEditor, entries: any[]): void {
    const filePath = editor.document.uri.fsPath;
    const fileEntries = entries.filter(
      (e) => (e.filePath || e.file) === filePath
    );

    const highDecorations: vscode.DecorationOptions[] = [];
    const mediumDecorations: vscode.DecorationOptions[] = [];
    const lowDecorations: vscode.DecorationOptions[] = [];
    const securityDecorations: vscode.DecorationOptions[] = [];

    for (const entry of fileEntries) {
      const line = (entry.line || 1) - 1;
      if (line < 0 || line >= editor.document.lineCount) continue;

      const range = editor.document.lineAt(line).range;
      const criticality = (entry.criticality || entry.severity || "low").toLowerCase();
      const label = this.buildLabel(entry);

      const decoration: vscode.DecorationOptions = {
        range,
        hoverMessage: new vscode.MarkdownString(this.buildHoverMessage(entry)),
        renderOptions: {
          after: { contentText: label },
        },
      };

      if (entry.securityAnnotation || entry.security) {
        securityDecorations.push(decoration);
      } else if (criticality === "high" || criticality === "critical") {
        highDecorations.push(decoration);
      } else if (criticality === "medium") {
        mediumDecorations.push(decoration);
      } else {
        lowDecorations.push(decoration);
      }
    }

    editor.setDecorations(this.highCriticalityType, highDecorations);
    editor.setDecorations(this.mediumCriticalityType, mediumDecorations);
    editor.setDecorations(this.lowCriticalityType, lowDecorations);
    editor.setDecorations(this.securityAnnotationType, securityDecorations);
  }

  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.highCriticalityType, []);
    editor.setDecorations(this.mediumCriticalityType, []);
    editor.setDecorations(this.lowCriticalityType, []);
    editor.setDecorations(this.securityAnnotationType, []);
  }

  dispose(): void {
    this.highCriticalityType.dispose();
    this.mediumCriticalityType.dispose();
    this.lowCriticalityType.dispose();
    this.securityAnnotationType.dispose();
  }

  private buildLabel(entry: any): string {
    const parts: string[] = [];
    const criticality = (entry.criticality || entry.severity || "").toUpperCase();

    if (criticality) {
      parts.push(`[${criticality}]`);
    }

    if (entry.securityAnnotation || entry.security) {
      parts.push(entry.securityAnnotation || entry.security);
    }

    if (entry.httpMethod && entry.httpUrl) {
      parts.push(`${entry.httpMethod} ${entry.httpUrl}`);
    } else if (entry.eventType) {
      parts.push(entry.eventType);
    }

    return parts.length > 0 ? " " + parts.join(" ") : "";
  }

  private buildHoverMessage(entry: any): string {
    const lines: string[] = ["**Manifest Analysis**", ""];

    if (entry.handlerName || entry.handler) {
      lines.push(`**Handler:** \`${entry.handlerName || entry.handler}\``);
    }
    if (entry.eventType) {
      lines.push(`**Event:** ${entry.eventType}`);
    }
    if (entry.httpMethod) {
      lines.push(`**HTTP:** ${entry.httpMethod} ${entry.httpUrl || ""}`);
    }
    if (entry.framework) {
      lines.push(`**Framework:** ${entry.framework}`);
    }
    if (entry.criticality || entry.severity) {
      lines.push(`**Criticality:** ${entry.criticality || entry.severity}`);
    }
    if (entry.securityAnnotation || entry.security) {
      lines.push(`**Security:** ${entry.securityAnnotation || entry.security}`);
    }

    return lines.join("\n");
  }
}
