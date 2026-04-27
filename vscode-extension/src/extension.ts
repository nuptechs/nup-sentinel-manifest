import * as vscode from "vscode";
import { LocalAnalyzer, Interaction } from "./local-analyzer";
import { RemoteAnalyzer } from "./remote-analyzer";
import { ManifestTreeProvider } from "./providers/tree-provider";
import { ManifestDecorationProvider } from "./providers/decoration-provider";
import { CatalogPanel } from "./panels/catalog-panel";

let analysisResults: any = null;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const localAnalyzer = new LocalAnalyzer();
  const treeProvider = new ManifestTreeProvider();
  const decorationProvider = new ManifestDecorationProvider();
  const catalogPanel = new CatalogPanel(context);

  vscode.window.registerTreeDataProvider("nup-manifest-catalog-tree", treeProvider);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = "$(shield) Manifest";
  statusBarItem.tooltip = "Manifest - Click to analyze";
  statusBarItem.command = "nup-manifest.analyzeFile";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && analysisResults?.interactions) {
        decorationProvider.updateDecorations(editor, analysisResults.interactions);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.analyzeFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active file to analyze.");
        return;
      }

      setStatus("analyzing");
      try {
        const filePath = editor.document.uri.fsPath;
        const content = editor.document.getText();
        const interactions = localAnalyzer.analyzeFile(filePath, content);

        analysisResults = {
          interactions,
          endpoints: interactions.filter((i) => i.httpMethod),
          security: [],
        };

        treeProvider.setData(analysisResults);
        decorationProvider.updateDecorations(editor, interactions);
        setStatus("done", interactions.length);
        vscode.window.showInformationMessage(
          `Manifest: Found ${interactions.length} interaction(s) in ${filePath.split("/").pop()}`
        );
      } catch (err: any) {
        setStatus("error");
        vscode.window.showErrorMessage(`Manifest analysis failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.analyzeWorkspace", async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      setStatus("analyzing");
      try {
        const extensions = ["vue", "tsx", "jsx", "ts", "js"];
        const pattern = `**/*.{${extensions.join(",")}}`;
        const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 500);

        const files: { path: string; content: string }[] = [];
        for (const uri of uris) {
          const doc = await vscode.workspace.openTextDocument(uri);
          files.push({ path: uri.fsPath, content: doc.getText() });
        }

        const interactions = localAnalyzer.analyzeWorkspace(files);
        analysisResults = {
          interactions,
          endpoints: interactions.filter((i) => i.httpMethod),
          security: [],
        };

        treeProvider.setData(analysisResults);

        const editor = vscode.window.activeTextEditor;
        if (editor) {
          decorationProvider.updateDecorations(editor, interactions);
        }

        setStatus("done", interactions.length);
        vscode.window.showInformationMessage(
          `Manifest: Analyzed ${files.length} file(s), found ${interactions.length} interaction(s)`
        );
      } catch (err: any) {
        setStatus("error");
        vscode.window.showErrorMessage(`Manifest workspace analysis failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.analyzeWorkspaceFull", async () => {
      const config = vscode.workspace.getConfiguration("nup-manifest");
      const serverUrl = config.get<string>("serverUrl", "");
      const apiKey = config.get<string>("apiKey", "");

      if (!serverUrl) {
        vscode.window.showWarningMessage(
          "Manifest server URL not configured. Run 'Manifest: Connect to Server' first."
        );
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      setStatus("uploading");
      try {
        const uris = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 1000);
        const files: { path: string; content: string }[] = [];

        for (const uri of uris) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            files.push({ path: uri.fsPath, content: doc.getText() });
          } catch {
            // skip binary/unreadable files
          }
        }

        const remote = new RemoteAnalyzer(serverUrl, apiKey);
        analysisResults = await remote.analyzeFiles(files);

        treeProvider.setData(analysisResults);

        const editor = vscode.window.activeTextEditor;
        if (editor && analysisResults?.interactions) {
          decorationProvider.updateDecorations(editor, analysisResults.interactions);
        }

        const count = analysisResults?.interactions?.length || 0;
        setStatus("done", count);
        vscode.window.showInformationMessage(
          `Manifest: Full analysis complete. ${count} interaction(s) found.`
        );
      } catch (err: any) {
        setStatus("error");
        vscode.window.showErrorMessage(`Manifest remote analysis failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.showCatalog", () => {
      if (!analysisResults) {
        vscode.window.showWarningMessage(
          "No analysis results. Run an analysis first."
        );
        return;
      }
      catalogPanel.show(analysisResults);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.connectServer", async () => {
      const config = vscode.workspace.getConfiguration("nup-manifest");

      const serverUrl = await vscode.window.showInputBox({
        prompt: "Enter Manifest server URL",
        value: config.get<string>("serverUrl", ""),
        placeHolder: "https://your-manifest-server.com",
      });

      if (serverUrl === undefined) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter API key (leave empty if not required)",
        value: config.get<string>("apiKey", ""),
        placeHolder: "your-api-key",
        password: true,
      });

      if (apiKey === undefined) return;

      await config.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Global);
      await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `Manifest: Connected to ${serverUrl}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nup-manifest.clearResults", () => {
      analysisResults = null;
      treeProvider.clear();

      const editor = vscode.window.activeTextEditor;
      if (editor) {
        decorationProvider.clearDecorations(editor);
      }

      setStatus("idle");
      vscode.window.showInformationMessage("Manifest: Results cleared.");
    })
  );

  context.subscriptions.push(decorationProvider);
}

function setStatus(state: "idle" | "analyzing" | "uploading" | "done" | "error", count?: number) {
  switch (state) {
    case "idle":
      statusBarItem.text = "$(shield) Manifest";
      statusBarItem.tooltip = "Manifest - Click to analyze";
      break;
    case "analyzing":
      statusBarItem.text = "$(loading~spin) Manifest: Analyzing...";
      statusBarItem.tooltip = "Analysis in progress";
      break;
    case "uploading":
      statusBarItem.text = "$(cloud-upload) Manifest: Uploading...";
      statusBarItem.tooltip = "Sending files to server";
      break;
    case "done":
      statusBarItem.text = `$(shield) Manifest: ${count || 0} found`;
      statusBarItem.tooltip = `Analysis complete - ${count || 0} interaction(s)`;
      break;
    case "error":
      statusBarItem.text = "$(error) Manifest: Error";
      statusBarItem.tooltip = "Analysis encountered an error";
      break;
  }
}

export function deactivate() {}
