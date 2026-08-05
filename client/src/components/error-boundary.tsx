import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Boundary de erro de render. Sem isto, um único `throw` no render de qualquer
 * tela desmonta a árvore React inteira → tela 100% branca. Com isto, o crash
 * vira um card localizado e o resto do app segue funcionando. Em App.tsx o
 * boundary é remontado por rota (`key={location}`), então navegar para outra
 * tela limpa o erro.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] render crash:", error, info);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <h2 className="mb-1 text-lg font-semibold">Algo quebrou nesta tela</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Um erro impediu a renderização desta parte. O resto do app segue
            funcionando — tente de novo ou navegue para outra tela.
          </p>
          <pre className="mb-4 max-h-32 overflow-auto rounded bg-muted p-2 text-left text-xs text-muted-foreground">
            {error.message || String(error)}
          </pre>
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={this.reset}>
              Tentar de novo
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Recarregar
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
