// ─────────────────────────────────────────────
// MermaidView — renderiza texto Mermaid → SVG no navegador. Tema segue o do app
// (claro/escuro). Erro de sintaxe vira mensagem, não tela quebrada. Re-renderiza
// quando o código OU o tema mudam. securityLevel 'strict' (rótulos são texto puro).
// ─────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { AlertTriangle } from "lucide-react";

let renderSeq = 0;

export function MermaidView({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!code || !code.trim()) {
      if (ref.current) ref.current.innerHTML = "";
      setError(null);
      return;
    }
    setBusy(true);
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      flowchart: { htmlLabels: false, curve: "basis" },
      sequence: { useMaxWidth: true },
    });
    const id = `uml-svg-${++renderSeq}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String((e as { message?: string })?.message || e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">Não consegui desenhar este diagrama.</div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="w-full overflow-x-auto">
      <div ref={ref} className="mermaid-render flex min-w-min justify-center [&_svg]:h-auto [&_svg]:max-w-none" data-busy={busy} />
    </div>
  );
}
