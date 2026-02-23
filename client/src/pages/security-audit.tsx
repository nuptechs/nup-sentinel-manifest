import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Shield,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  Eye,
  Lock,
  Unlock,
  TrendingUp,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface SecurityFinding {
  id: number;
  analysisRunId: number;
  projectId: number;
  findingId: string;
  findingType: string;
  severity: string;
  title: string;
  description: string;
  evidence: any;
  recommendation: string;
  affectedEndpoints: string[] | null;
  createdAt: string;
}

interface Project {
  id: number;
  name: string;
  status: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

const SEVERITY_CONFIG: Record<string, { color: string; bgClass: string; textClass: string; darkBgClass: string; darkTextClass: string; icon: typeof AlertCircle }> = {
  critical: { color: "red", bgClass: "bg-red-100", textClass: "text-red-700", darkBgClass: "dark:bg-red-900/30", darkTextClass: "dark:text-red-300", icon: AlertCircle },
  high: { color: "orange", bgClass: "bg-orange-100", textClass: "text-orange-700", darkBgClass: "dark:bg-orange-900/30", darkTextClass: "dark:text-orange-300", icon: AlertTriangle },
  medium: { color: "yellow", bgClass: "bg-yellow-100", textClass: "text-yellow-700", darkBgClass: "dark:bg-yellow-900/30", darkTextClass: "dark:text-yellow-300", icon: ShieldAlert },
  low: { color: "blue", bgClass: "bg-blue-100", textClass: "text-blue-700", darkBgClass: "dark:bg-blue-900/30", darkTextClass: "dark:text-blue-300", icon: Shield },
  info: { color: "gray", bgClass: "bg-gray-100", textClass: "text-gray-700", darkBgClass: "dark:bg-gray-900/30", darkTextClass: "dark:text-gray-300", icon: Eye },
};

const FINDING_TYPE_LABELS: Record<string, string> = {
  UNPROTECTED_OUTLIER: "Unprotected Outlier",
  PRIVILEGE_ESCALATION: "Privilege Escalation",
  MISSING_PROTECTION: "Missing Protection",
  SENSITIVE_DATA_EXPOSURE: "Sensitive Data Exposure",
  INCONSISTENT_PROTECTION: "Inconsistent Protection",
  COVERAGE_GAP: "Coverage Gap",
};

function SeverityBadge({ severity }: { severity: string }) {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${config.bgClass} ${config.textClass} ${config.darkBgClass} ${config.darkTextClass}`}
      data-testid={`badge-severity-${severity}`}
    >
      <config.icon className="h-3 w-3" />
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
}

function FindingTypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" className="text-xs" data-testid={`badge-type-${type}`}>
      {FINDING_TYPE_LABELS[type] || type}
    </Badge>
  );
}

function SeverityDistributionBar({ findings }: { findings: SecurityFinding[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach((f) => { c[f.severity] = (c[f.severity] || 0) + 1; });
    return c;
  }, [findings]);

  const total = findings.length;
  if (total === 0) return null;

  const barColors: Record<string, string> = {
    critical: "bg-red-500",
    high: "bg-orange-500",
    medium: "bg-yellow-500",
    low: "bg-blue-500",
    info: "bg-gray-400",
  };

  return (
    <Card data-testid="card-severity-distribution">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Severity Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex rounded-md overflow-hidden h-4 mb-3" data-testid="bar-severity-distribution">
          {SEVERITY_ORDER.map((sev) => {
            const count = counts[sev];
            if (count === 0) return null;
            const pct = (count / total) * 100;
            return (
              <div
                key={sev}
                className={`${barColors[sev]} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${sev}: ${count}`}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-4">
          {SEVERITY_ORDER.map((sev) => (
            <div key={sev} className="flex items-center gap-1.5 text-xs" data-testid={`text-severity-count-${sev}`}>
              <div className={`h-2.5 w-2.5 rounded-sm ${barColors[sev]}`} />
              <span className="capitalize text-muted-foreground">{sev}</span>
              <span className="font-semibold">{counts[sev]}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceDetails({ evidence }: { evidence: any }) {
  if (!evidence) return null;

  return (
    <div className="space-y-4 mt-3">
      {evidence.targetEntry && (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Target Endpoint</h5>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div>
              <span className="text-xs text-muted-foreground block">Endpoint</span>
              <span className="font-mono text-xs">
                <Badge variant="outline" className="mr-1 text-xs">{evidence.targetEntry.httpMethod || "?"}</Badge>
                {evidence.targetEntry.endpoint || "N/A"}
              </span>
            </div>
            {evidence.targetEntry.controllerClass && (
              <div>
                <span className="text-xs text-muted-foreground block">Controller</span>
                <span className="font-mono text-xs">{evidence.targetEntry.controllerClass}</span>
              </div>
            )}
            {evidence.targetEntry.criticalityScore != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Criticality</span>
                <span className={`font-semibold text-xs ${evidence.targetEntry.criticalityScore >= 70 ? "text-red-500" : evidence.targetEntry.criticalityScore >= 40 ? "text-amber-500" : "text-green-500"}`}>
                  {evidence.targetEntry.criticalityScore}
                </span>
              </div>
            )}
            {evidence.targetEntry.entitiesTouched && evidence.targetEntry.entitiesTouched.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground block">Entities</span>
                <div className="flex flex-wrap gap-1">
                  {evidence.targetEntry.entitiesTouched.map((e: string, i: number) => (
                    <Badge key={i} variant="secondary" className="text-xs">{e}</Badge>
                  ))}
                </div>
              </div>
            )}
            {evidence.targetEntry.sensitiveFieldsAccessed && evidence.targetEntry.sensitiveFieldsAccessed.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground block">Sensitive Fields</span>
                <div className="flex flex-wrap gap-1">
                  {evidence.targetEntry.sensitiveFieldsAccessed.map((f: string, i: number) => (
                    <Badge key={i} variant="destructive" className="text-xs">
                      <Eye className="h-2.5 w-2.5 mr-0.5" />{f}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {evidence.targetEntry.securityAnnotations && evidence.targetEntry.securityAnnotations.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground block">Security Annotations</span>
                <div className="flex flex-wrap gap-1">
                  {evidence.targetEntry.securityAnnotations.map((a: any, i: number) => (
                    <span key={i} className="text-xs font-mono flex items-center gap-0.5">
                      <Lock className="h-2.5 w-2.5 text-green-500" />@{a.type || a}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          {evidence.targetEntry.requiredRoles && evidence.targetEntry.requiredRoles.length === 0 && (
            <div className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
              <Unlock className="h-3 w-3" />
              No required roles — endpoint is unprotected
            </div>
          )}
        </div>
      )}

      {evidence.peerEntries && evidence.peerEntries.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Peer Comparison</h5>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Endpoint</TableHead>
                  <TableHead className="text-xs">Method</TableHead>
                  <TableHead className="text-xs">Roles</TableHead>
                  <TableHead className="text-xs">Annotations</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evidence.peerEntries.map((peer: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-mono">{peer.endpoint || "N/A"}</TableCell>
                    <TableCell className="text-xs">{peer.httpMethod || "?"}</TableCell>
                    <TableCell className="text-xs">
                      {peer.requiredRoles && peer.requiredRoles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {peer.requiredRoles.map((r: string, j: number) => (
                            <Badge key={j} variant="secondary" className="text-xs">{r}</Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-red-500 flex items-center gap-1"><Unlock className="h-3 w-3" />None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {peer.securityAnnotations && peer.securityAnnotations.length > 0 ? (
                        peer.securityAnnotations.map((a: any, j: number) => (
                          <span key={j} className="font-mono">@{a.type || a} </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {evidence.comparison && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Protection Comparison</h5>
          <p className="text-sm">
            <span className="font-semibold">{evidence.comparison.protectedCount ?? "?"}</span> of{" "}
            <span className="font-semibold">{evidence.comparison.totalPeers ?? "?"}</span> peers protected
            {evidence.comparison.protectionRate != null && (
              <span className="ml-1">({Math.round(evidence.comparison.protectionRate)}%)</span>
            )}
          </p>
          {evidence.comparison.commonRoles && evidence.comparison.commonRoles.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground">Common roles:</span>
              {evidence.comparison.commonRoles.map((r: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">{r}</Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {evidence.metrics && (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Coverage Metrics</h5>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {evidence.metrics.totalEndpoints != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Total Endpoints</span>
                <span className="font-semibold">{evidence.metrics.totalEndpoints}</span>
              </div>
            )}
            {evidence.metrics.protectedEndpoints != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Protected</span>
                <span className="font-semibold text-green-600 dark:text-green-400">{evidence.metrics.protectedEndpoints}</span>
              </div>
            )}
            {evidence.metrics.unprotectedEndpoints != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Unprotected</span>
                <span className="font-semibold text-red-500">{evidence.metrics.unprotectedEndpoints}</span>
              </div>
            )}
            {evidence.metrics.coveragePercent != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Coverage</span>
                <span className="font-semibold">{Math.round(evidence.metrics.coveragePercent)}%</span>
              </div>
            )}
          </div>
          {evidence.metrics.byMethod && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">By HTTP Method:</span>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {Object.entries(evidence.metrics.byMethod).map(([method, stats]: [string, any]) => (
                  <div key={method} className="text-xs">
                    <Badge variant="outline" className="text-xs mr-1">{method}</Badge>
                    <span>{stats.protected ?? 0}/{stats.total ?? 0} protected</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: SecurityFinding }) {
  const [open, setOpen] = useState(false);
  const endpointCount = finding.affectedEndpoints?.length ?? 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card data-testid={`card-finding-${finding.id}`}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-start p-4 h-auto text-left"
            data-testid={`button-expand-finding-${finding.id}`}
          >
            <div className="flex items-center gap-3 w-full flex-wrap">
              {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <SeverityBadge severity={finding.severity} />
              <span className="font-medium text-sm flex-1 min-w-0 truncate">{finding.title}</span>
              <FindingTypeBadge type={finding.findingType} />
              {endpointCount > 0 && (
                <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid={`text-endpoints-count-${finding.id}`}>
                  {endpointCount} endpoint{endpointCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4 space-y-3">
            <p className="text-sm text-foreground" data-testid={`text-finding-description-${finding.id}`}>
              {finding.description}
            </p>

            {finding.recommendation && (
              <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 p-3" data-testid={`text-finding-recommendation-${finding.id}`}>
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-semibold text-blue-700 dark:text-blue-300 block mb-1">Recommendation</span>
                    <p className="text-sm text-blue-800 dark:text-blue-200">{finding.recommendation}</p>
                  </div>
                </div>
              </div>
            )}

            {finding.affectedEndpoints && finding.affectedEndpoints.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Affected Endpoints</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {finding.affectedEndpoints.map((ep, i) => (
                    <Badge key={i} variant="outline" className="text-xs font-mono">{ep}</Badge>
                  ))}
                </div>
              </div>
            )}

            <EvidenceDetails evidence={finding.evidence} />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export default function SecurityAuditPage() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: findings, isLoading: loadingFindings } = useQuery<SecurityFinding[]>({
    queryKey: [`/api/projects/${selectedProjectId}/security-findings`],
    enabled: !!selectedProjectId,
  });

  const summaryStats = useMemo(() => {
    if (!findings) return { total: 0, criticalHigh: 0, coverage: null as number | null, protectionRate: 0 };

    const total = findings.length;
    const criticalHigh = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;

    let coverage: number | null = null;
    const coverageGap = findings.find((f) => f.findingType === "COVERAGE_GAP");
    if (coverageGap?.evidence?.metrics?.coveragePercent != null) {
      coverage = Math.round(coverageGap.evidence.metrics.coveragePercent);
    }

    let protectionRate = 0;
    if (total > 0) {
      const withProtection = findings.filter((f) => {
        const ev = f.evidence;
        if (!ev) return false;
        if (ev.comparison?.protectionRate != null) return ev.comparison.protectionRate > 50;
        if (ev.targetEntry?.requiredRoles?.length > 0) return true;
        return false;
      }).length;
      protectionRate = Math.round(((total - withProtection) / total) * 100);
    }

    return { total, criticalHigh, coverage, protectionRate };
  }, [findings]);

  const groupedFindings = useMemo(() => {
    if (!findings) return [];
    const groups: { severity: string; findings: SecurityFinding[] }[] = [];
    for (const sev of SEVERITY_ORDER) {
      const sevFindings = findings.filter((f) => f.severity === sev);
      if (sevFindings.length > 0) {
        groups.push({ severity: sev, findings: sevFindings });
      }
    }
    return groups;
  }, [findings]);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Security Audit</h1>
        <p className="text-muted-foreground mt-1">
          Security findings from the Omission Engine — what should be protected but isn't.
        </p>
      </div>

      <div className="max-w-sm">
        <label className="text-sm font-medium mb-2 block">Project</label>
        <Select
          value={selectedProjectId}
          onValueChange={setSelectedProjectId}
          data-testid="select-project"
        >
          <SelectTrigger data-testid="select-project-trigger">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {loadingProjects ? (
              <SelectItem value="__loading" disabled>Loading...</SelectItem>
            ) : (
              projects?.map((p) => (
                <SelectItem key={p.id} value={String(p.id)} data-testid={`option-project-${p.id}`}>
                  {p.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {!selectedProjectId && (
        <Card data-testid="card-empty-state">
          <CardContent className="py-12 text-center">
            <Shield className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground" data-testid="text-empty-state">
              Select a project to view security findings
            </p>
          </CardContent>
        </Card>
      )}

      {selectedProjectId && loadingFindings && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i}>
                <CardContent className="pt-6">
                  <Skeleton className="h-4 w-20 mb-2" />
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Skeleton className="h-24 w-full" />
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {selectedProjectId && !loadingFindings && findings && findings.length === 0 && (
        <Card data-testid="card-no-findings">
          <CardContent className="py-12 text-center">
            <ShieldCheck className="h-12 w-12 mx-auto text-green-500 mb-4" />
            <p className="text-muted-foreground" data-testid="text-no-findings">
              No security findings — this project has not been analyzed yet or has no backend endpoints
            </p>
          </CardContent>
        </Card>
      )}

      {selectedProjectId && !loadingFindings && findings && findings.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card data-testid="card-total-findings">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Total Findings</span>
                  <Shield className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-bold" data-testid="text-total-findings">{summaryStats.total}</p>
              </CardContent>
            </Card>

            <Card data-testid="card-critical-high">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Critical & High</span>
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                </div>
                <p className={`text-2xl font-bold ${summaryStats.criticalHigh > 0 ? "text-red-500" : ""}`} data-testid="text-critical-high">
                  {summaryStats.criticalHigh}
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-security-coverage">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Security Coverage</span>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </div>
                <p className="text-2xl font-bold" data-testid="text-security-coverage">
                  {summaryStats.coverage != null ? `${summaryStats.coverage}%` : "N/A"}
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-protection-rate">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Findings Rate</span>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-bold" data-testid="text-protection-rate">
                  {summaryStats.protectionRate}%
                </p>
              </CardContent>
            </Card>
          </div>

          <SeverityDistributionBar findings={findings} />

          <div className="space-y-6">
            {groupedFindings.map((group) => {
              const config = SEVERITY_CONFIG[group.severity] || SEVERITY_CONFIG.info;
              return (
                <div key={group.severity} data-testid={`section-severity-${group.severity}`}>
                  <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-md ${config.bgClass} ${config.darkBgClass}`}>
                    <config.icon className={`h-4 w-4 ${config.textClass} ${config.darkTextClass}`} />
                    <h3 className={`text-sm font-semibold capitalize ${config.textClass} ${config.darkTextClass}`}>
                      {group.severity} ({group.findings.length})
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {group.findings.map((finding) => (
                      <FindingCard key={finding.id} finding={finding} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
