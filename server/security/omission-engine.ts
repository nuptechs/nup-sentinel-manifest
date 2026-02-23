import type { CatalogEntry } from "@shared/schema";

export interface SecurityFinding {
  id: string;
  type: "UNPROTECTED_OUTLIER" | "PRIVILEGE_ESCALATION" | "MISSING_PROTECTION" | "SENSITIVE_DATA_EXPOSURE" | "INCONSISTENT_PROTECTION" | "COVERAGE_GAP";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  evidence: FindingEvidence;
  recommendation: string;
  affectedEndpoints: string[];
}

export interface FindingEvidence {
  targetEntry?: {
    endpoint: string;
    httpMethod: string;
    controller: string;
    controllerMethod: string;
    criticalityScore: number;
    securityAnnotations: any[];
    requiredRoles: string[];
    entitiesTouched: string[];
    sensitiveFields: string[];
  };
  peerEntries?: {
    endpoint: string;
    httpMethod: string;
    controller: string;
    requiredRoles: string[];
    securityAnnotations: any[];
  }[];
  comparison?: {
    protectedCount: number;
    unprotectedCount: number;
    totalPeers: number;
    protectionRate: number;
    commonRoles: string[];
    groupKey: string;
  };
  metrics?: {
    totalEndpoints: number;
    protectedEndpoints: number;
    coveragePercent: number;
    criticalUnprotected: number;
    highUnprotected: number;
    byHttpMethod: Record<string, { total: number; protected: number }>;
  };
}

export interface SecurityCoverageMetrics {
  totalEndpoints: number;
  protectedEndpoints: number;
  unprotectedEndpoints: number;
  coveragePercent: number;
  criticalUnprotected: number;
  highUnprotected: number;
  byHttpMethod: Record<string, { total: number; protected: number; percent: number }>;
  byController: Record<string, { total: number; protected: number; percent: number }>;
  roleDistribution: Record<string, number>;
}

export class SecurityOmissionEngine {
  private entries: CatalogEntry[];
  private backendEntries: CatalogEntry[];
  private findings: SecurityFinding[];
  private findingCounter: number;

  constructor(entries: CatalogEntry[]) {
    this.entries = entries;
    this.backendEntries = entries.filter(e => e.endpoint && e.httpMethod);
    this.findings = [];
    this.findingCounter = 0;
  }

  analyze(): { findings: SecurityFinding[]; metrics: SecurityCoverageMetrics } {
    this.findings = [];
    this.findingCounter = 0;

    this.detectUnprotectedOutliers();
    this.detectPrivilegeEscalation();
    this.detectSensitiveDataExposure();
    this.detectInconsistentProtection();
    this.detectMissingProtectionOnCritical();

    const metrics = this.computeCoverageMetrics();
    this.addCoverageFindings(metrics);

    this.findings.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    return { findings: this.findings, metrics };
  }

  private nextId(): string {
    return `SF-${String(++this.findingCounter).padStart(3, "0")}`;
  }

  private isProtected(entry: CatalogEntry): boolean {
    const roles = entry.requiredRoles as string[] | null;
    const annotations = entry.securityAnnotations as any[] | null;
    return !!((roles && roles.length > 0) || (annotations && annotations.length > 0));
  }

  private getRoles(entry: CatalogEntry): string[] {
    return (entry.requiredRoles as string[] | null) || [];
  }

  private getAnnotations(entry: CatalogEntry): any[] {
    return (entry.securityAnnotations as any[] | null) || [];
  }

  private getEntities(entry: CatalogEntry): string[] {
    return (entry.entitiesTouched as string[] | null) || [];
  }

  private getSensitiveFields(entry: CatalogEntry): string[] {
    return (entry.sensitiveFieldsAccessed as string[] | null) || [];
  }

  private normalizeEndpoint(endpoint: string): string {
    return endpoint.replace(/\{[^}]+\}/g, "{id}").replace(/\/+$/, "");
  }

  private extractPathPattern(endpoint: string): string {
    const normalized = this.normalizeEndpoint(endpoint);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 1) return normalized;
    return "/" + parts.slice(0, -1).join("/");
  }

  private extractEntityDomain(entry: CatalogEntry): string | null {
    const entities = this.getEntities(entry);
    if (entities.length > 0) return entities[0].toLowerCase();

    const endpoint = entry.endpoint || "";
    const parts = endpoint.split("/").filter(Boolean);
    const apiIndex = parts.findIndex(p => p === "api" || p === "v1" || p === "v2" || p === "v3");
    const relevantParts = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;
    for (const part of relevantParts) {
      if (!part.startsWith("{") && part !== "api") {
        return part.replace(/s$/, "").toLowerCase();
      }
    }
    return null;
  }

  private buildTargetEvidence(entry: CatalogEntry): FindingEvidence["targetEntry"] {
    return {
      endpoint: entry.endpoint || "",
      httpMethod: entry.httpMethod || "",
      controller: entry.controllerClass || "",
      controllerMethod: entry.controllerMethod || "",
      criticalityScore: entry.criticalityScore || 0,
      securityAnnotations: this.getAnnotations(entry),
      requiredRoles: this.getRoles(entry),
      entitiesTouched: this.getEntities(entry),
      sensitiveFields: this.getSensitiveFields(entry),
    };
  }

  private detectUnprotectedOutliers(): void {
    if (this.backendEntries.length < 3) return;

    const groups = new Map<string, CatalogEntry[]>();

    for (const entry of this.backendEntries) {
      const method = (entry.httpMethod || "").toUpperCase();
      const domain = this.extractEntityDomain(entry);
      if (!domain) continue;

      const key = `${method}:${domain}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    for (const [groupKey, groupEntries] of Array.from(groups.entries())) {
      if (groupEntries.length < 2) continue;

      const protectedEntries = groupEntries.filter((e: CatalogEntry) => this.isProtected(e));
      const unprotectedEntries = groupEntries.filter((e: CatalogEntry) => !this.isProtected(e));

      if (protectedEntries.length === 0 || unprotectedEntries.length === 0) continue;

      const protectionRate = protectedEntries.length / groupEntries.length;
      if (protectionRate < 0.5) continue;

      const commonRoles = this.findCommonRoles(protectedEntries);

      for (const unprotected of unprotectedEntries) {
        const criticality = unprotected.criticalityScore || 0;
        let severity: SecurityFinding["severity"] = "medium";
        if (criticality >= 70) severity = "critical";
        else if (criticality >= 50) severity = "high";
        else if (criticality >= 30) severity = "medium";
        else severity = "low";

        const [method, domain] = groupKey.split(":");
        const peerEndpoints = protectedEntries.map(e => `${e.httpMethod} ${e.endpoint}`).join(", ");

        this.findings.push({
          id: this.nextId(),
          type: "UNPROTECTED_OUTLIER",
          severity,
          title: `Unprotected ${method} /${domain} endpoint — peers are protected`,
          description: `The endpoint ${unprotected.httpMethod} ${unprotected.endpoint} has criticality score ${criticality} but no security annotation. ${protectedEntries.length} of ${groupEntries.length} similar ${method} endpoints touching "${domain}" entities have security protections${commonRoles.length > 0 ? ` (commonly requiring ${commonRoles.join(", ")})` : ""}. This endpoint is the outlier.`,
          evidence: {
            targetEntry: this.buildTargetEvidence(unprotected),
            peerEntries: protectedEntries.map(e => ({
              endpoint: e.endpoint || "",
              httpMethod: e.httpMethod || "",
              controller: e.controllerClass || "",
              requiredRoles: this.getRoles(e),
              securityAnnotations: this.getAnnotations(e),
            })),
            comparison: {
              protectedCount: protectedEntries.length,
              unprotectedCount: unprotectedEntries.length,
              totalPeers: groupEntries.length,
              protectionRate: Math.round(protectionRate * 100),
              commonRoles,
              groupKey,
            },
          },
          recommendation: commonRoles.length > 0
            ? `Add @PreAuthorize("hasAnyRole(${commonRoles.map(r => `'${r}'`).join(", ")})") to match peer endpoint protections.`
            : `Add appropriate security annotation (@PreAuthorize, @Secured, or @RolesAllowed) to match peer endpoint protections.`,
          affectedEndpoints: [`${unprotected.httpMethod} ${unprotected.endpoint}`],
        });
      }
    }
  }

  private detectPrivilegeEscalation(): void {
    const privilegeFields = [
      "role", "roles", "userRole", "userRoles", "authority", "authorities",
      "permission", "permissions", "isAdmin", "is_admin", "admin",
      "privilege", "privileges", "accessLevel", "access_level",
      "superuser", "superUser", "isSuperAdmin",
    ];

    const privilegeEntityPatterns = [
      /role/i, /authority/i, /permission/i, /privilege/i,
    ];

    for (const entry of this.backendEntries) {
      const method = (entry.httpMethod || "").toUpperCase();
      if (!["POST", "PUT", "PATCH"].includes(method)) continue;

      const entities = this.getEntities(entry);
      const entityFields = (entry.entityFieldsMetadata as any[] | null) || [];
      const sensitiveFields = this.getSensitiveFields(entry);

      const touchesPrivilegeEntity = entities.some(e =>
        privilegeEntityPatterns.some(p => p.test(e))
      );

      const touchesPrivilegeField = sensitiveFields.some(f =>
        privilegeFields.some(pf => f.toLowerCase().includes(pf.toLowerCase()))
      );

      const hasPrivilegeFieldInEntity = entityFields.some((ef: any) => {
        if (!ef || !ef.fields) return false;
        return ef.fields.some((f: any) =>
          privilegeFields.some(pf => (f.name || "").toLowerCase().includes(pf.toLowerCase()))
        );
      });

      if (!touchesPrivilegeEntity && !touchesPrivilegeField && !hasPrivilegeFieldInEntity) continue;

      if (this.isProtected(entry)) {
        const roles = this.getRoles(entry);
        const hasAdminRole = roles.some(r =>
          /admin|superuser|root|system/i.test(r)
        );
        if (hasAdminRole) continue;

        this.findings.push({
          id: this.nextId(),
          type: "PRIVILEGE_ESCALATION",
          severity: "high",
          title: `Privilege-sensitive ${method} endpoint with insufficient role protection`,
          description: `${entry.httpMethod} ${entry.endpoint} writes to entities or fields that control access privileges (${entities.join(", ")}) but the required roles (${roles.join(", ")}) do not include an administrative role. Any authenticated user with these roles could potentially escalate privileges.`,
          evidence: { targetEntry: this.buildTargetEvidence(entry) },
          recommendation: `Verify that the required roles (${roles.join(", ")}) are sufficiently restrictive for privilege management operations. Consider requiring an explicit admin role like ROLE_ADMIN.`,
          affectedEndpoints: [`${entry.httpMethod} ${entry.endpoint}`],
        });
        continue;
      }

      this.findings.push({
        id: this.nextId(),
        type: "PRIVILEGE_ESCALATION",
        severity: "critical",
        title: `Unprotected write to privilege-controlling data`,
        description: `${entry.httpMethod} ${entry.endpoint} writes to entities or fields that control access privileges (${[...entities, ...sensitiveFields.filter(f => privilegeFields.some(pf => f.toLowerCase().includes(pf.toLowerCase())))].join(", ")}) but has NO security annotation. Any caller can potentially modify privilege data, enabling privilege escalation.`,
        evidence: { targetEntry: this.buildTargetEvidence(entry) },
        recommendation: `Immediately add @PreAuthorize("hasRole('ADMIN')") or equivalent high-privilege role restriction. This is a potential privilege escalation vector.`,
        affectedEndpoints: [`${entry.httpMethod} ${entry.endpoint}`],
      });
    }
  }

  private detectSensitiveDataExposure(): void {
    const highSensitivityPatterns = [
      /password/i, /secret/i, /token/i, /apikey/i, /api_key/i,
      /creditcard/i, /credit_card/i, /ssn/i, /socialSecurity/i,
    ];

    for (const entry of this.backendEntries) {
      const method = (entry.httpMethod || "").toUpperCase();
      if (method !== "GET") continue;

      const sensitiveFields = this.getSensitiveFields(entry);
      const highSensitiveFields = sensitiveFields.filter(f =>
        highSensitivityPatterns.some(p => p.test(f))
      );

      if (highSensitiveFields.length === 0) continue;

      if (!this.isProtected(entry)) {
        this.findings.push({
          id: this.nextId(),
          type: "SENSITIVE_DATA_EXPOSURE",
          severity: "critical",
          title: `Unprotected endpoint exposes highly sensitive data`,
          description: `${entry.httpMethod} ${entry.endpoint} accesses highly sensitive fields (${highSensitiveFields.join(", ")}) but has no security protection. This data could be exposed to any unauthenticated caller.`,
          evidence: { targetEntry: this.buildTargetEvidence(entry) },
          recommendation: `Add security annotation immediately. Sensitive fields like ${highSensitiveFields.join(", ")} must never be accessible without authentication and proper authorization.`,
          affectedEndpoints: [`${entry.httpMethod} ${entry.endpoint}`],
        });
      } else {
        const roles = this.getRoles(entry);
        if (roles.length > 0 && roles.every(r => !/admin|system|root/i.test(r))) {
          this.findings.push({
            id: this.nextId(),
            type: "SENSITIVE_DATA_EXPOSURE",
            severity: "medium",
            title: `Highly sensitive data accessible by non-admin roles`,
            description: `${entry.httpMethod} ${entry.endpoint} accesses highly sensitive fields (${highSensitiveFields.join(", ")}) but is accessible to roles: ${roles.join(", ")}. Consider whether these roles should have access to ${highSensitiveFields.join(", ")}.`,
            evidence: { targetEntry: this.buildTargetEvidence(entry) },
            recommendation: `Review whether roles ${roles.join(", ")} should access sensitive fields. Consider field-level filtering or restricting to admin-only.`,
            affectedEndpoints: [`${entry.httpMethod} ${entry.endpoint}`],
          });
        }
      }
    }
  }

  private detectInconsistentProtection(): void {
    const controllerGroups = new Map<string, CatalogEntry[]>();

    for (const entry of this.backendEntries) {
      const controller = entry.controllerClass;
      if (!controller) continue;
      if (!controllerGroups.has(controller)) controllerGroups.set(controller, []);
      controllerGroups.get(controller)!.push(entry);
    }

    for (const [controller, ctrlEntries] of Array.from(controllerGroups.entries())) {
      if (ctrlEntries.length < 2) continue;

      const protectedEntries = ctrlEntries.filter((e: CatalogEntry) => this.isProtected(e));
      const unprotectedEntries = ctrlEntries.filter((e: CatalogEntry) => !this.isProtected(e));

      if (protectedEntries.length === 0 || unprotectedEntries.length === 0) continue;

      const protectionRate = protectedEntries.length / ctrlEntries.length;
      if (protectionRate < 0.5) continue;

      const mutatingUnprotected = unprotectedEntries.filter((e: CatalogEntry) => {
        const method = (e.httpMethod || "").toUpperCase();
        return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      });

      if (mutatingUnprotected.length === 0) continue;

      const commonRoles = this.findCommonRoles(protectedEntries);

      this.findings.push({
        id: this.nextId(),
        type: "INCONSISTENT_PROTECTION",
        severity: mutatingUnprotected.some((e: CatalogEntry) => (e.criticalityScore || 0) >= 50) ? "high" : "medium",
        title: `Inconsistent protection in ${controller}`,
        description: `Controller ${controller} has ${protectedEntries.length}/${ctrlEntries.length} endpoints protected, but ${mutatingUnprotected.length} mutating endpoint(s) (${mutatingUnprotected.map((e: CatalogEntry) => `${e.httpMethod} ${e.endpoint}`).join(", ")}) have no security annotation. This is likely an oversight since ${Math.round(protectionRate * 100)}% of the controller is protected${commonRoles.length > 0 ? ` with roles ${commonRoles.join(", ")}` : ""}.`,
        evidence: {
          targetEntry: this.buildTargetEvidence(mutatingUnprotected[0]),
          peerEntries: protectedEntries.slice(0, 5).map((e: CatalogEntry) => ({
            endpoint: e.endpoint || "",
            httpMethod: e.httpMethod || "",
            controller: e.controllerClass || "",
            requiredRoles: this.getRoles(e),
            securityAnnotations: this.getAnnotations(e),
          })),
          comparison: {
            protectedCount: protectedEntries.length,
            unprotectedCount: unprotectedEntries.length,
            totalPeers: ctrlEntries.length,
            protectionRate: Math.round(protectionRate * 100),
            commonRoles,
            groupKey: controller,
          },
        },
        recommendation: `Add security annotations to the unprotected endpoints in ${controller}. Based on peer methods, consider requiring ${commonRoles.length > 0 ? commonRoles.join(" or ") : "appropriate roles"}.`,
        affectedEndpoints: mutatingUnprotected.map((e: CatalogEntry) => `${e.httpMethod} ${e.endpoint}`),
      });
    }
  }

  private detectMissingProtectionOnCritical(): void {
    for (const entry of this.backendEntries) {
      if (this.isProtected(entry)) continue;

      const criticality = entry.criticalityScore || 0;
      if (criticality < 60) continue;

      const alreadyReported = this.findings.some(f =>
        f.affectedEndpoints.includes(`${entry.httpMethod} ${entry.endpoint}`)
      );
      if (alreadyReported) continue;

      const method = (entry.httpMethod || "").toUpperCase();
      const entities = this.getEntities(entry);

      this.findings.push({
        id: this.nextId(),
        type: "MISSING_PROTECTION",
        severity: criticality >= 80 ? "critical" : "high",
        title: `High-criticality ${method} endpoint without security protection`,
        description: `${entry.httpMethod} ${entry.endpoint} has a criticality score of ${criticality}/100${entities.length > 0 ? ` and touches entities ${entities.join(", ")}` : ""} but has no security annotation. Endpoints with this criticality level typically require explicit authorization.`,
        evidence: { targetEntry: this.buildTargetEvidence(entry) },
        recommendation: `Add @PreAuthorize or @Secured annotation. With a criticality score of ${criticality}, this endpoint likely requires role-based access control.`,
        affectedEndpoints: [`${entry.httpMethod} ${entry.endpoint}`],
      });
    }
  }

  private addCoverageFindings(metrics: SecurityCoverageMetrics): void {
    if (metrics.totalEndpoints === 0) return;

    this.findings.push({
      id: this.nextId(),
      type: "COVERAGE_GAP",
      severity: "info",
      title: `Security coverage: ${metrics.coveragePercent}% of endpoints protected`,
      description: `${metrics.protectedEndpoints} of ${metrics.totalEndpoints} backend endpoints have security annotations. ${metrics.criticalUnprotected} critical and ${metrics.highUnprotected} high-criticality endpoints are unprotected.`,
      evidence: {
        metrics: {
          totalEndpoints: metrics.totalEndpoints,
          protectedEndpoints: metrics.protectedEndpoints,
          coveragePercent: metrics.coveragePercent,
          criticalUnprotected: metrics.criticalUnprotected,
          highUnprotected: metrics.highUnprotected,
          byHttpMethod: Object.fromEntries(
            Object.entries(metrics.byHttpMethod).map(([k, v]) => [k, { total: v.total, protected: v.protected }])
          ),
        },
      },
      recommendation: metrics.coveragePercent < 50
        ? `Security coverage is below 50%. Prioritize adding protections to DELETE and POST endpoints first, especially those touching sensitive entities.`
        : metrics.coveragePercent < 80
          ? `Security coverage is moderate. Focus on the ${metrics.criticalUnprotected + metrics.highUnprotected} critical/high-criticality unprotected endpoints.`
          : `Good security coverage. Review the remaining ${metrics.unprotectedEndpoints} unprotected endpoints for intentional public access.`,
      affectedEndpoints: [],
    });

    for (const [method, stats] of Object.entries(metrics.byHttpMethod)) {
      if (method === "GET") continue;
      const methodCoverage = stats.total > 0 ? Math.round((stats.protected / stats.total) * 100) : 100;
      if (methodCoverage < 50 && stats.total >= 2) {
        this.findings.push({
          id: this.nextId(),
          type: "COVERAGE_GAP",
          severity: method === "DELETE" ? "high" : "medium",
          title: `Low security coverage for ${method} endpoints: ${methodCoverage}%`,
          description: `Only ${stats.protected} of ${stats.total} ${method} endpoints have security annotations. ${method} operations are ${method === "DELETE" ? "destructive" : "state-changing"} and typically require authorization.`,
          evidence: {
            metrics: {
              totalEndpoints: stats.total,
              protectedEndpoints: stats.protected,
              coveragePercent: methodCoverage,
              criticalUnprotected: 0,
              highUnprotected: 0,
              byHttpMethod: { [method]: { total: stats.total, protected: stats.protected } },
            },
          },
          recommendation: `Audit all ${method} endpoints and add appropriate security annotations. ${method} operations should default to requiring authentication.`,
          affectedEndpoints: [],
        });
      }
    }
  }

  computeCoverageMetrics(): SecurityCoverageMetrics {
    const byHttpMethod: Record<string, { total: number; protected: number; percent: number }> = {};
    const byController: Record<string, { total: number; protected: number; percent: number }> = {};
    const roleDistribution: Record<string, number> = {};
    let criticalUnprotected = 0;
    let highUnprotected = 0;
    let protectedCount = 0;

    for (const entry of this.backendEntries) {
      const method = (entry.httpMethod || "UNKNOWN").toUpperCase();
      const controller = entry.controllerClass || "Unknown";
      const isProtected = this.isProtected(entry);
      const criticality = entry.criticalityScore || 0;

      if (!byHttpMethod[method]) byHttpMethod[method] = { total: 0, protected: 0, percent: 0 };
      byHttpMethod[method].total++;
      if (isProtected) {
        byHttpMethod[method].protected++;
        protectedCount++;
      }

      if (!byController[controller]) byController[controller] = { total: 0, protected: 0, percent: 0 };
      byController[controller].total++;
      if (isProtected) byController[controller].protected++;

      if (!isProtected) {
        if (criticality >= 70) criticalUnprotected++;
        else if (criticality >= 50) highUnprotected++;
      }

      for (const role of this.getRoles(entry)) {
        roleDistribution[role] = (roleDistribution[role] || 0) + 1;
      }
    }

    for (const stats of Object.values(byHttpMethod)) {
      stats.percent = stats.total > 0 ? Math.round((stats.protected / stats.total) * 100) : 100;
    }
    for (const stats of Object.values(byController)) {
      stats.percent = stats.total > 0 ? Math.round((stats.protected / stats.total) * 100) : 100;
    }

    return {
      totalEndpoints: this.backendEntries.length,
      protectedEndpoints: protectedCount,
      unprotectedEndpoints: this.backendEntries.length - protectedCount,
      coveragePercent: this.backendEntries.length > 0
        ? Math.round((protectedCount / this.backendEntries.length) * 100)
        : 100,
      criticalUnprotected,
      highUnprotected,
      byHttpMethod,
      byController,
      roleDistribution,
    };
  }

  private findCommonRoles(entries: CatalogEntry[]): string[] {
    const roleCounts = new Map<string, number>();
    for (const entry of entries) {
      for (const role of this.getRoles(entry)) {
        roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
      }
    }

    const threshold = Math.ceil(entries.length * 0.4);
    return Array.from(roleCounts.entries())
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([role]) => role);
  }
}

export function analyzeSecurityOmissions(entries: CatalogEntry[]): {
  findings: SecurityFinding[];
  metrics: SecurityCoverageMetrics;
} {
  const engine = new SecurityOmissionEngine(entries);
  return engine.analyze();
}

export function generatePRSecuritySummary(
  newEntries: CatalogEntry[],
  existingEntries: CatalogEntry[]
): {
  findings: SecurityFinding[];
  metrics: SecurityCoverageMetrics;
  prSummary: {
    newEndpoints: number;
    newProtected: number;
    newUnprotected: number;
    repoProtectionRate: number;
    prProtectionRate: number;
    protectionDelta: number;
  };
} {
  const allEntries = [...existingEntries, ...newEntries];
  const engine = new SecurityOmissionEngine(allEntries);
  const { findings, metrics } = engine.analyze();

  const newBackend = newEntries.filter(e => e.endpoint && e.httpMethod);
  const newProtected = newBackend.filter(e => {
    const roles = e.requiredRoles as string[] | null;
    const annotations = e.securityAnnotations as any[] | null;
    return (roles && roles.length > 0) || (annotations && annotations.length > 0);
  });

  const existingBackend = existingEntries.filter(e => e.endpoint && e.httpMethod);
  const existingProtected = existingBackend.filter(e => {
    const roles = e.requiredRoles as string[] | null;
    const annotations = e.securityAnnotations as any[] | null;
    return (roles && roles.length > 0) || (annotations && annotations.length > 0);
  });

  const repoRate = existingBackend.length > 0
    ? Math.round((existingProtected.length / existingBackend.length) * 100)
    : 100;
  const prRate = newBackend.length > 0
    ? Math.round((newProtected.length / newBackend.length) * 100)
    : 100;

  return {
    findings,
    metrics,
    prSummary: {
      newEndpoints: newBackend.length,
      newProtected: newProtected.length,
      newUnprotected: newBackend.length - newProtected.length,
      repoProtectionRate: repoRate,
      prProtectionRate: prRate,
      protectionDelta: prRate - repoRate,
    },
  };
}
