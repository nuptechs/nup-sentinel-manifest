import { Switch, Route, useLocation } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import UploadPage from "@/pages/upload";
import CatalogPage from "@/pages/catalog";
import InsightsPage from "@/pages/insights";
import SystemMapPage from "@/pages/system-map";
import DiffViewerPage from "@/pages/diff-viewer";
import GitIntegrationPage from "@/pages/git-integration";
import SettingsPage from "@/pages/settings";
import ConventionsPage from "@/pages/conventions";
import SecurityAuditPage from "@/pages/security-audit";

function Router() {
  // Boundary chaveado por rota: um crash numa tela vira card localizado, e
  // navegar para outra rota remonta o boundary (limpa o erro).
  const [location] = useLocation();
  return (
    <ErrorBoundary key={location}>
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/upload" component={UploadPage} />
      <Route path="/catalog" component={CatalogPage} />
      <Route path="/insights" component={InsightsPage} />
      <Route path="/system-map" component={SystemMapPage} />
      <Route path="/diff" component={DiffViewerPage} />
      <Route path="/git" component={GitIntegrationPage} />
      <Route path="/security" component={SecurityAuditPage} />
      <Route path="/conventions" component={ConventionsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
    </ErrorBoundary>
  );
}

export default function App() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider style={style as React.CSSProperties}>
            <div className="flex h-screen w-full">
              <AppSidebar />
              <div className="flex flex-col flex-1 min-w-0">
                <header className="flex items-center justify-between gap-2 p-2 border-b shrink-0 sticky top-0 z-50 bg-background">
                  <SidebarTrigger data-testid="button-sidebar-toggle" />
                  <ThemeToggle />
                </header>
                <main className="flex-1 overflow-auto">
                  <Router />
                </main>
              </div>
            </div>
          </SidebarProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
