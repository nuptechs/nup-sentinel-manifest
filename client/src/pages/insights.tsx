import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Search,
  MonitorSmartphone,
  MousePointerClick,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Globe,
  Server,
  Database,
  Layers,
  Lock,
  FileCode,
  Zap,
  AlertTriangle,
  Eye,
  FormInput,
  Navigation,
  Link2,
  Tag,
  Hash,
} from "lucide-react";
import type { CatalogEntry, Project } from "@shared/schema";

type InteractionGroup = {
  category: string;
  label: string;
  icon: typeof MousePointerClick;
  entries: CatalogEntry[];
};

type ScreenGroup = {
  screenName: string;
  entries: CatalogEntry[];
  interactionGroups: InteractionGroup[];
  stats: {
    totalInteractions: number;
    endpointCount: number;
    avgCriticality: number;
    maxCriticality: number;
    operationTypes: Map<string, number>;
    hasBackend: boolean;
    hasSecurity: boolean;
  };
};

function categorizeInteraction(entry: CatalogEntry): { category: string; label: string; icon: typeof MousePointerClick } {
  const type = entry.interactionType?.toLowerCase() || "";
  const interaction = entry.interaction?.toLowerCase() || "";
  const category = entry.interactionCategory || "";

  if (type.includes("form") || type.includes("submit") || interaction.includes("submit") || interaction.includes("form")) {
    return { category: "form", label: "Forms", icon: FormInput };
  }
  if (type.includes("navigation") || type.includes("route") || category === "UI_ONLY" && interaction.includes("navigat")) {
    return { category: "navigation", label: "Navigation", icon: Navigation };
  }
  if (type.includes("link") || interaction.includes("link") || interaction.includes("href")) {
    return { category: "link", label: "Links", icon: Link2 };
  }
  if (type.includes("click") || type.includes("button") || interaction.includes("click") || interaction.includes("button")) {
    return { category: "action", label: "Actions", icon: MousePointerClick };
  }
  if (type.includes("load") || type.includes("init") || type.includes("mount") || interaction.includes("load") || interaction.includes("fetch")) {
    return { category: "data", label: "Data Loading", icon: Database };
  }
  if (category === "HTTP" || entry.endpoint) {
    return { category: "api", label: "API Calls", icon: Globe };
  }
  return { category: "other", label: "Other", icon: Zap };
}

function buildScreenGroups(entries: CatalogEntry[]): ScreenGroup[] {
  const screenMap = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const screen = entry.screen || "Unknown Screen";
    if (!screenMap.has(screen)) screenMap.set(screen, []);
    screenMap.get(screen)!.push(entry);
  }

  const groups: ScreenGroup[] = [];
  for (const [screenName, screenEntries] of Array.from(screenMap.entries())) {
    const categoryMap = new Map<string, { label: string; icon: typeof MousePointerClick; entries: CatalogEntry[] }>();
    for (const entry of screenEntries) {
      const cat = categorizeInteraction(entry);
      if (!categoryMap.has(cat.category)) {
        categoryMap.set(cat.category, { label: cat.label, icon: cat.icon, entries: [] });
      }
      categoryMap.get(cat.category)!.entries.push(entry);
    }

    const interactionGroups: InteractionGroup[] = [];
    const categoryOrder = ["form", "action", "data", "api", "link", "navigation", "other"];
    for (const cat of categoryOrder) {
      const group = categoryMap.get(cat);
      if (group) {
        interactionGroups.push({ category: cat, ...group });
      }
    }

    const endpoints = new Set(screenEntries.filter(e => e.endpoint).map(e => e.endpoint!));
    const opTypes = new Map<string, number>();
    for (const e of screenEntries) {
      if (e.technicalOperation) {
        opTypes.set(e.technicalOperation, (opTypes.get(e.technicalOperation) || 0) + 1);
      }
    }
    const criticalities = screenEntries.map(e => e.criticalityScore ?? 0);
    const hasSecurityEntries = screenEntries.some(e =>
      (e.requiredRoles as string[] || []).length > 0 ||
      (e.securityAnnotations as unknown[] || []).length > 0 ||
      (e.routeGuards as string[] || []).length > 0
    );

    groups.push({
      screenName,
      entries: screenEntries,
      interactionGroups,
      stats: {
        totalInteractions: screenEntries.length,
        endpointCount: endpoints.size,
        avgCriticality: criticalities.length > 0 ? Math.round(criticalities.reduce((a, b) => a + b, 0) / criticalities.length) : 0,
        maxCriticality: Math.max(...criticalities, 0),
        operationTypes: opTypes,
        hasBackend: screenEntries.some(e => !!e.controllerClass),
        hasSecurity: hasSecurityEntries,
      },
    });
  }

  groups.sort((a, b) => b.stats.totalInteractions - a.stats.totalInteractions);
  return groups;
}

function CriticalityBar({ score }: { score: number }) {
  let colorClass = "bg-green-500";
  let Icon = ShieldCheck;
  if (score >= 70) { colorClass = "bg-red-500"; Icon = ShieldAlert; }
  else if (score >= 40) { colorClass = "bg-amber-500"; Icon = Shield; }

  return (
    <div className="flex items-center gap-1.5">
      <Icon className={`h-3 w-3 ${score >= 70 ? "text-red-500" : score >= 40 ? "text-amber-500" : "text-green-600 dark:text-green-400"}`} />
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${Math.min(score, 100)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{score}</span>
    </div>
  );
}

function HttpMethodBadge({ method }: { method: string | null }) {
  if (!method) return null;
  const colors: Record<string, string> = {
    GET: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    POST: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    PUT: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    PATCH: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    DELETE: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider whitespace-nowrap ${colors[method.toUpperCase()] || "bg-muted text-muted-foreground"}`}>
      {method.toUpperCase()}
    </span>
  );
}

function OperationBadge({ operation }: { operation: string | null }) {
  if (!operation) return null;
  const colorMap: Record<string, string> = {
    READ: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    WRITE: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    DELETE: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    STATE_CHANGE: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    FILE_IO: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
    EXTERNAL_INTEGRATION: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    NAVIGATION: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
    AUTHENTICATION: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    CREATE: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    UPDATE: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    EXPORT: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${colorMap[operation] || "bg-muted text-muted-foreground"}`}>
      {operation}
    </span>
  );
}

function InteractionBlock({
  entry,
  onClick,
}: {
  entry: CatalogEntry;
  onClick: () => void;
}) {
  const hasBackend = !!entry.controllerClass;
  const hasSecurity = (entry.requiredRoles as string[] || []).length > 0 ||
    (entry.securityAnnotations as unknown[] || []).length > 0;
  const isGateway = entry.architectureType === "WS_OPERATION_BASED";

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-2.5 rounded-md border bg-background hover-elevate active-elevate-2 transition-colors group"
      data-testid={`block-interaction-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" title={entry.interaction} data-testid={`text-interaction-name-${entry.id}`}>
            {entry.interaction}
          </p>
          {entry.endpoint && (
            <div className="flex items-center gap-1.5 mt-1">
              <HttpMethodBadge method={entry.httpMethod} />
              <span className="text-xs text-muted-foreground truncate" title={entry.endpoint} data-testid={`text-endpoint-${entry.id}`}>
                {entry.endpoint}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasSecurity && <Lock className="h-3 w-3 text-amber-500" />}
          {isGateway && <Tag className="h-3 w-3 text-purple-500" />}
          {hasBackend ? (
            <Server className="h-3 w-3 text-blue-500" />
          ) : (
            <MonitorSmartphone className="h-3 w-3 text-slate-400" />
          )}
          <ArrowRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
    </button>
  );
}

function TraceStep({
  icon: Icon,
  label,
  value,
  detail,
  badges,
  isLast,
  children,
}: {
  icon: typeof Server;
  label: string;
  value: string;
  detail?: string | null;
  badges?: { text: string; className: string }[];
  isLast?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 border border-primary/20">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-1" />}
      </div>
      <div className="flex-1 pb-6">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-sm font-medium mt-0.5 break-all">{value}</p>
        {detail && <p className="text-xs text-muted-foreground mt-0.5 break-all">{detail}</p>}
        {badges && badges.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {badges.map((b, i) => (
              <span key={i} className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${b.className}`}>
                {b.text}
              </span>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function TracePanel({
  entry,
  open,
  onOpenChange,
}: {
  entry: CatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!entry) return null;

  const resolutionPath = entry.resolutionPath as { tier: string; file: string; function: string | null; detail: string | null }[] | null;
  const serviceMethods = entry.serviceMethods as string[] || [];
  const repositoryMethods = entry.repositoryMethods as string[] || [];
  const entitiesTouched = entry.entitiesTouched as string[] || [];
  const fullCallChain = entry.fullCallChain as string[] || [];
  const persistenceOps = entry.persistenceOperations as string[] || [];
  const requiredRoles = entry.requiredRoles as string[] || [];
  const securityAnnotations = entry.securityAnnotations as { type: string; expression: string; roles: string[] }[] || [];
  const entityFieldsMeta = entry.entityFieldsMetadata as { entity: string; fields: { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[] }[] || [];
  const sensitiveFields = entry.sensitiveFieldsAccessed as string[] || [];
  const routeGuards = entry.routeGuards as string[] || [];

  const hasBackend = !!entry.controllerClass;
  const stepCount = 1 + (entry.endpoint ? 1 : 0) + (hasBackend ? 1 : 0) + (serviceMethods.length > 0 ? 1 : 0) + (repositoryMethods.length > 0 ? 1 : 0) + (entitiesTouched.length > 0 ? 1 : 0);
  let currentStep = 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:w-[540px] sm:max-w-lg overflow-hidden flex flex-col" side="right" data-testid="panel-trace">
        <SheetHeader className="shrink-0">
          <SheetTitle className="text-base" data-testid="text-trace-title">Resolution Trace</SheetTitle>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <OperationBadge operation={entry.technicalOperation} />
            <CriticalityBar score={entry.criticalityScore ?? 0} />
            {entry.architectureType === "WS_OPERATION_BASED" && (
              <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                Gateway
              </span>
            )}
          </div>
          {entry.suggestedMeaning && (
            <p className="text-sm text-muted-foreground mt-1">{entry.suggestedMeaning}</p>
          )}
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 pr-2">
          <div className="space-y-0">
            <TraceStep
              icon={MousePointerClick}
              label="Frontend Interaction"
              value={entry.interaction}
              detail={`Screen: ${entry.screen}${entry.sourceFile ? ` | ${entry.sourceFile}${entry.lineNumber ? `:${entry.lineNumber}` : ""}` : ""}`}
              badges={[
                ...(entry.interactionType ? [{ text: entry.interactionType, className: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" }] : []),
                ...(entry.frontendRoute ? [{ text: `Route: ${entry.frontendRoute}`, className: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" }] : []),
                ...routeGuards.map(g => ({ text: `Guard: ${g}`, className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" })),
              ]}
              isLast={++currentStep === stepCount}
            />

            {entry.endpoint && (
              <TraceStep
                icon={Globe}
                label="HTTP Call"
                value={`${entry.httpMethod || "?"} ${entry.endpoint}`}
                detail={entry.operationHint ? `Operation Hint: ${entry.operationHint}` : null}
                badges={entry.interactionCategory ? [{ text: entry.interactionCategory, className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" }] : []}
                isLast={++currentStep === stepCount}
              />
            )}

            {hasBackend && (
              <TraceStep
                icon={Server}
                label="Controller"
                value={`${entry.controllerClass}.${entry.controllerMethod || "?"}`}
                badges={[
                  ...requiredRoles.map(r => ({ text: r, className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" })),
                  ...securityAnnotations.map(a => ({ text: `${a.type}(${a.expression || a.roles?.join(", ") || ""})`, className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" })),
                ]}
                isLast={++currentStep === stepCount}
              />
            )}

            {serviceMethods.length > 0 && (
              <TraceStep
                icon={Layers}
                label="Service Layer"
                value={serviceMethods[0]}
                detail={serviceMethods.length > 1 ? `+${serviceMethods.length - 1} more methods` : null}
                isLast={++currentStep === stepCount}
              >
                {serviceMethods.length > 1 && (
                  <div className="mt-1.5 space-y-0.5">
                    {serviceMethods.slice(1).map((m, i) => (
                      <p key={i} className="text-xs text-muted-foreground break-all pl-2 border-l border-border">{m}</p>
                    ))}
                  </div>
                )}
              </TraceStep>
            )}

            {repositoryMethods.length > 0 && (
              <TraceStep
                icon={Database}
                label="Repository / Persistence"
                value={repositoryMethods[0]}
                detail={repositoryMethods.length > 1 ? `+${repositoryMethods.length - 1} more methods` : null}
                badges={persistenceOps.map(op => ({ text: op, className: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" }))}
                isLast={++currentStep === stepCount}
              >
                {repositoryMethods.length > 1 && (
                  <div className="mt-1.5 space-y-0.5">
                    {repositoryMethods.slice(1).map((m, i) => (
                      <p key={i} className="text-xs text-muted-foreground break-all pl-2 border-l border-border">{m}</p>
                    ))}
                  </div>
                )}
              </TraceStep>
            )}

            {entitiesTouched.length > 0 && (
              <TraceStep
                icon={FileCode}
                label="Entities Touched"
                value={entitiesTouched.join(", ")}
                isLast={++currentStep === stepCount}
              >
                {sensitiveFields.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                    {sensitiveFields.map((f, i) => (
                      <span key={i} className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                {entityFieldsMeta.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {entityFieldsMeta.map((em, i) => (
                      <Collapsible key={i}>
                        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`trigger-entity-${em.entity}`}>
                          <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]>&]:rotate-90" />
                          {em.entity} ({em.fields.length} fields)
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="mt-1 pl-4 space-y-0.5">
                            {em.fields.map((f, fi) => (
                              <p key={fi} className={`text-xs ${f.isSensitive ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>
                                {f.isSensitive && <Lock className="inline h-2.5 w-2.5 mr-0.5" />}
                                {f.name}: {f.type}
                                {f.isId && " (PK)"}
                                {f.validations && f.validations.length > 0 && ` [${f.validations.join(", ")}]`}
                              </p>
                            ))}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    ))}
                  </div>
                )}
              </TraceStep>
            )}
          </div>

          {resolutionPath && resolutionPath.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="trigger-resolution-path">
                  <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]>&]:rotate-90" />
                  Resolution Path ({resolutionPath.length} tiers)
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 space-y-1.5 pl-2">
                    {resolutionPath.map((step, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="inline-flex items-center justify-center shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono tabular-nums">
                          T{i + 1}
                        </span>
                        <div className="min-w-0">
                          <span className="font-medium">{step.tier}</span>
                          {step.function && <span className="text-muted-foreground"> - {step.function}</span>}
                          <p className="text-muted-foreground truncate" title={step.file}>{step.file}</p>
                          {step.detail && <p className="text-muted-foreground italic">{step.detail}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {fullCallChain.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="trigger-full-call-chain">
                  <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]>&]:rotate-90" />
                  Full Call Chain ({fullCallChain.length} steps)
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 space-y-0.5 pl-2">
                    {fullCallChain.map((step, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                        <span className="text-foreground break-all">{step}</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {!hasBackend && !entry.endpoint && (
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MonitorSmartphone className="h-3.5 w-3.5" />
                <span>Frontend-only interaction — no backend endpoint detected</span>
              </div>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function ScreenCard({
  group,
  onSelectEntry,
}: {
  group: ScreenGroup;
  onSelectEntry: (entry: CatalogEntry) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const screenLabel = group.screenName.includes("/")
    ? group.screenName.split("/").pop() || group.screenName
    : group.screenName.replace(/\.vue$|\.tsx$|\.jsx$|\.ts$|\.component\.ts$|\.component\.html$/, "");

  const fullPath = group.screenName;

  return (
    <Card data-testid={`card-screen-${group.screenName.replace(/[^a-zA-Z0-9]/g, "-")}`}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-3" data-testid={`trigger-screen-${group.screenName.replace(/[^a-zA-Z0-9]/g, "-")}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <MonitorSmartphone className="h-4 w-4 text-primary shrink-0" />
                  <CardTitle className="text-base truncate" title={fullPath} data-testid={`text-screen-name-${group.screenName.replace(/[^a-zA-Z0-9]/g, "-")}`}>
                    {screenLabel}
                  </CardTitle>
                  {group.stats.hasSecurity && (
                    <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate" title={fullPath}>{fullPath}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <div className="flex items-center gap-2 justify-end">
                    <Badge variant="secondary" className="tabular-nums">
                      {group.stats.totalInteractions} interaction{group.stats.totalInteractions !== 1 ? "s" : ""}
                    </Badge>
                    {group.stats.endpointCount > 0 && (
                      <Badge variant="outline" className="tabular-nums">
                        {group.stats.endpointCount} endpoint{group.stats.endpointCount !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1">
                    <CriticalityBar score={group.stats.maxCriticality} />
                  </div>
                </div>
                {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </div>
            </div>
            {!expanded && (
              <div className="flex flex-wrap gap-1 mt-2">
                {Array.from(group.stats.operationTypes.entries()).map(([op, count]) => (
                  <span key={op} className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                    {op} ({count})
                  </span>
                ))}
              </div>
            )}
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {group.interactionGroups.map((ig) => {
              const Icon = ig.icon;
              return (
                <div key={ig.category}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{ig.label}</span>
                    <span className="text-xs text-muted-foreground">({ig.entries.length})</span>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {ig.entries.map((entry) => (
                      <InteractionBlock
                        key={entry.id}
                        entry={entry}
                        onClick={() => onSelectEntry(entry)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function SummaryStats({ entries, screenGroups }: { entries: CatalogEntry[]; screenGroups: ScreenGroup[] }) {
  const stats = useMemo(() => {
    const opCounts = new Map<string, number>();
    let withBackend = 0;
    let frontendOnly = 0;
    let withSecurity = 0;
    let totalCriticality = 0;

    for (const e of entries) {
      if (e.technicalOperation) opCounts.set(e.technicalOperation, (opCounts.get(e.technicalOperation) || 0) + 1);
      if (e.controllerClass) withBackend++; else frontendOnly++;
      if ((e.requiredRoles as string[] || []).length > 0 || (e.securityAnnotations as unknown[] || []).length > 0) withSecurity++;
      totalCriticality += e.criticalityScore ?? 0;
    }

    const uniqueEndpoints = new Set(entries.filter(e => e.endpoint).map(e => e.endpoint!)).size;
    const uniqueControllers = new Set(entries.filter(e => e.controllerClass).map(e => e.controllerClass!)).size;
    const uniqueEntities = new Set(entries.flatMap(e => e.entitiesTouched as string[] || [])).size;
    const backendCoverage = entries.length > 0 ? Math.round((withBackend / entries.length) * 100) : 0;

    return {
      totalScreens: screenGroups.length,
      totalInteractions: entries.length,
      uniqueEndpoints,
      uniqueControllers,
      uniqueEntities,
      backendCoverage,
      withSecurity,
      avgCriticality: entries.length > 0 ? Math.round(totalCriticality / entries.length) : 0,
      opCounts: Array.from(opCounts.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [entries, screenGroups]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <div className="flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Screens</span>
          </div>
          <p className="text-2xl font-bold mt-1 tabular-nums" data-testid="text-total-screens">{stats.totalScreens}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <div className="flex items-center gap-2">
            <MousePointerClick className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Interactions</span>
          </div>
          <p className="text-2xl font-bold mt-1 tabular-nums" data-testid="text-total-interactions">{stats.totalInteractions}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Endpoints</span>
          </div>
          <p className="text-2xl font-bold mt-1 tabular-nums" data-testid="text-total-endpoints">{stats.uniqueEndpoints}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Backend Coverage</span>
          </div>
          <p className="text-2xl font-bold mt-1 tabular-nums" data-testid="text-backend-coverage">{stats.backendCoverage}%</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <span className="text-xs text-muted-foreground">Avg Criticality</span>
          </div>
          <p className="text-2xl font-bold mt-1 tabular-nums">{stats.avgCriticality}</p>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-[10px] text-muted-foreground">{stats.uniqueControllers} controllers, {stats.uniqueEntities} entities, {stats.withSecurity} secured</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function InsightsPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const projectIdParam = params.get("projectId");

  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectIdParam || "");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterOp, setFilterOp] = useState<string>("all");
  const [filterScope, setFilterScope] = useState<string>("all");
  const [selectedEntry, setSelectedEntry] = useState<CatalogEntry | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: entries, isLoading: loadingEntries } = useQuery<CatalogEntry[]>({
    queryKey: ["/api/catalog-entries", selectedProjectId],
    enabled: !!selectedProjectId,
  });

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    return entries.filter((entry) => {
      const matchesSearch =
        !searchTerm ||
        entry.screen.toLowerCase().includes(searchTerm.toLowerCase()) ||
        entry.interaction.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (entry.endpoint || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (entry.controllerClass || "").toLowerCase().includes(searchTerm.toLowerCase());
      const matchesOp = filterOp === "all" || entry.technicalOperation === filterOp;
      const matchesScope =
        filterScope === "all" ||
        (filterScope === "backend" && !!entry.controllerClass) ||
        (filterScope === "frontend" && !entry.controllerClass);
      return matchesSearch && matchesOp && matchesScope;
    });
  }, [entries, searchTerm, filterOp, filterScope]);

  const screenGroups = useMemo(() => buildScreenGroups(filteredEntries), [filteredEntries]);

  const operationTypes = useMemo(() => {
    if (!entries) return [];
    const ops = new Set<string>();
    for (const e of entries) {
      if (e.technicalOperation) ops.add(e.technicalOperation);
    }
    return Array.from(ops).sort();
  }, [entries]);

  const handleSelectEntry = (entry: CatalogEntry) => {
    setSelectedEntry(entry);
    setTraceOpen(true);
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-insights-title">
          System Explorer
        </h1>
        <p className="text-muted-foreground mt-1">
          Visual map of screens, interactions, and their backend resolution paths
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-60">
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger data-testid="select-insights-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {(projects || []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search screens, interactions, endpoints..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
                data-testid="input-search-insights"
              />
            </div>
            <div className="w-44">
              <Select value={filterOp} onValueChange={setFilterOp}>
                <SelectTrigger data-testid="select-filter-operation-insights">
                  <SelectValue placeholder="All Operations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Operations</SelectItem>
                  {operationTypes.map((op) => (
                    <SelectItem key={op} value={op}>{op}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-40">
              <Select value={filterScope} onValueChange={setFilterScope}>
                <SelectTrigger data-testid="select-filter-scope-insights">
                  <SelectValue placeholder="All Scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scope</SelectItem>
                  <SelectItem value="backend">Has Backend</SelectItem>
                  <SelectItem value="frontend">Frontend Only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {loadingProjects && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {!selectedProjectId && !loadingProjects && (
        <Card>
          <CardContent className="py-16 text-center">
            <Eye className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">Select a project to explore its system map</p>
          </CardContent>
        </Card>
      )}

      {selectedProjectId && loadingEntries && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {selectedProjectId && !loadingEntries && entries && entries.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <FileCode className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No catalog entries found for this project</p>
            <p className="text-xs text-muted-foreground mt-1">Run an analysis first from the Catalog page</p>
          </CardContent>
        </Card>
      )}

      {selectedProjectId && !loadingEntries && entries && entries.length > 0 && (
        <>
          <SummaryStats entries={entries} screenGroups={screenGroups} />

          {filteredEntries.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Search className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-muted-foreground">No entries match your filters</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {screenGroups.length} screen{screenGroups.length !== 1 ? "s" : ""} with {filteredEntries.length} interaction{filteredEntries.length !== 1 ? "s" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  Click any interaction to see its full resolution trace
                </p>
              </div>
              {screenGroups.map((group) => (
                <ScreenCard
                  key={group.screenName}
                  group={group}
                  onSelectEntry={handleSelectEntry}
                />
              ))}
            </div>
          )}
        </>
      )}

      <TracePanel
        entry={selectedEntry}
        open={traceOpen}
        onOpenChange={setTraceOpen}
      />
    </div>
  );
}
