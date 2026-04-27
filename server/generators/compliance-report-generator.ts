import type { ManifestData } from "./manifest-generator";
import type { SecurityFindingRecord } from "@shared/schema";

export function generateComplianceReport(
  manifest: ManifestData,
  findings: SecurityFindingRecord[],
  project: { name: string; analyzedAt: string }
): string {
  const generatedAt = new Date().toISOString();
  const totalEndpoints = manifest.summary.totalEndpoints;
  const securityCoverage = manifest.summary.securityCoverage;
  const rolesCount = manifest.summary.totalRoles;
  const entitiesCount = manifest.summary.totalEntities;
  const criticalFindings = findings.filter(f => f.severity === "critical").length;

  const endpointsWithSensitive = manifest.endpoints.filter(e => e.sensitiveFieldsAccessed.length > 0);

  const severityColor = (severity: string): string => {
    switch (severity) {
      case "critical": return "#dc2626";
      case "high": return "#ea580c";
      case "medium": return "#ca8a04";
      case "low": return "#2563eb";
      case "info": return "#6b7280";
      default: return "#6b7280";
    }
  };

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const coverageByMethod: Record<string, { total: number; protected: number }> = {};
  const coverageByController: Record<string, { total: number; protected: number }> = {};

  for (const ep of manifest.endpoints) {
    const method = ep.method.toUpperCase();
    if (!coverageByMethod[method]) coverageByMethod[method] = { total: 0, protected: 0 };
    coverageByMethod[method].total++;
    if (ep.requiredRoles.length > 0 || ep.securityAnnotations.length > 0) coverageByMethod[method].protected++;

    const ctrl = ep.controller || "Unknown";
    if (!coverageByController[ctrl]) coverageByController[ctrl] = { total: 0, protected: 0 };
    coverageByController[ctrl].total++;
    if (ep.requiredRoles.length > 0 || ep.securityAnnotations.length > 0) coverageByController[ctrl].protected++;
  }

  const allRoleNames = manifest.roles.map(r => r.name);

  const checklistItems = [
    { label: "All endpoints documented", pass: totalEndpoints > 0 },
    { label: "Security coverage above 80%", pass: securityCoverage >= 80 },
    { label: "No critical security findings", pass: criticalFindings === 0 },
    { label: "All roles defined", pass: rolesCount > 0 },
    { label: "Sensitive data endpoints have protection", pass: endpointsWithSensitive.every(e => e.requiredRoles.length > 0 || e.securityAnnotations.length > 0) },
    { label: "All mutating endpoints protected", pass: manifest.endpoints.filter(e => ["POST", "PUT", "PATCH", "DELETE"].includes(e.method.toUpperCase())).every(e => e.requiredRoles.length > 0 || e.securityAnnotations.length > 0) },
    { label: "Entity access properly tracked", pass: entitiesCount > 0 },
    { label: "Personal data processing documented (LGPD Art. 37)", pass: endpointsWithSensitive.length === 0 || endpointsWithSensitive.every(e => e.requiredRoles.length > 0) },
  ];

  const renderEndpointTable = (): string => {
    if (manifest.endpoints.length === 0) return "<p>No endpoints found.</p>";
    let rows = "";
    for (const ep of manifest.endpoints) {
      const hasSensitive = ep.sensitiveFieldsAccessed.length > 0;
      rows += `<tr>
        <td><code>${escapeHtml(ep.method)}</code></td>
        <td><code>${escapeHtml(ep.path)}</code></td>
        <td>${escapeHtml(ep.controller)}</td>
        <td>${ep.requiredRoles.length > 0 ? ep.requiredRoles.map(r => `<span class="badge role">${escapeHtml(r)}</span>`).join(" ") : '<span class="badge none">NONE</span>'}</td>
        <td><span class="badge criticality-${ep.criticalityScore >= 70 ? "critical" : ep.criticalityScore >= 50 ? "high" : ep.criticalityScore >= 30 ? "medium" : "low"}">${ep.criticalityScore}</span></td>
        <td>${hasSensitive ? '<span class="badge sensitive">YES</span>' : '<span class="badge safe">NO</span>'}</td>
      </tr>`;
    }
    return `<table>
      <thead><tr><th>Method</th><th>Path</th><th>Controller</th><th>Roles</th><th>Criticality</th><th>Sensitive Data</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const renderAccessMatrix = (): string => {
    if (allRoleNames.length === 0 || manifest.endpoints.length === 0) return "<p>No access control matrix available.</p>";
    const headerCells = allRoleNames.map(r => `<th class="rotate">${escapeHtml(r)}</th>`).join("");
    let rows = "";
    for (const ep of manifest.endpoints) {
      const cells = allRoleNames.map(role => {
        const hasAccess = ep.requiredRoles.includes(role);
        return `<td class="${hasAccess ? "access-yes" : "access-no"}">${hasAccess ? "&#10003;" : "&#10007;"}</td>`;
      }).join("");
      rows += `<tr><td><code>${escapeHtml(ep.method)} ${escapeHtml(ep.path)}</code></td>${cells}</tr>`;
    }
    return `<table class="matrix">
      <thead><tr><th>Endpoint</th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const renderPersonalData = (): string => {
    if (endpointsWithSensitive.length === 0) return "<p>No endpoints accessing personal or sensitive data were identified.</p>";
    let rows = "";
    for (const ep of endpointsWithSensitive) {
      const isProtected = ep.requiredRoles.length > 0 || ep.securityAnnotations.length > 0;
      rows += `<tr>
        <td><code>${escapeHtml(ep.method)} ${escapeHtml(ep.path)}</code></td>
        <td>${ep.sensitiveFieldsAccessed.map(f => `<code>${escapeHtml(f)}</code>`).join(", ")}</td>
        <td>${ep.entitiesTouched.map(e => escapeHtml(e)).join(", ")}</td>
        <td><span class="badge ${isProtected ? "safe" : "sensitive"}">${isProtected ? "PROTECTED" : "UNPROTECTED"}</span></td>
        <td>${ep.requiredRoles.length > 0 ? ep.requiredRoles.join(", ") : "N/A"}</td>
      </tr>`;
    }
    return `<table>
      <thead><tr><th>Endpoint</th><th>Sensitive Fields</th><th>Entities</th><th>Protection Status</th><th>Required Roles</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const renderFindings = (): string => {
    if (findings.length === 0) return "<p>No security findings were identified.</p>";
    let html = "";
    for (const f of findings) {
      const color = severityColor(f.severity);
      const affected = (f.affectedEndpoints as string[] | null) || [];
      html += `<div class="finding">
        <div class="finding-header">
          <span class="severity-badge" style="background-color: ${color}; color: white;">${f.severity.toUpperCase()}</span>
          <strong>${escapeHtml(f.title)}</strong>
          <span class="finding-id">${escapeHtml(f.findingId)}</span>
        </div>
        <p>${escapeHtml(f.description)}</p>
        <div class="recommendation"><strong>Recommendation:</strong> ${escapeHtml(f.recommendation)}</div>
        ${affected.length > 0 ? `<div class="affected"><strong>Affected Endpoints:</strong> ${affected.map(e => `<code>${escapeHtml(e)}</code>`).join(", ")}</div>` : ""}
      </div>`;
    }
    return html;
  };

  const renderCoverageMetrics = (): string => {
    let methodRows = "";
    for (const [method, stats] of Object.entries(coverageByMethod)) {
      const pct = stats.total > 0 ? Math.round((stats.protected / stats.total) * 100) : 100;
      methodRows += `<tr><td>${method}</td><td>${stats.total}</td><td>${stats.protected}</td><td><div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div> ${pct}%</td></tr>`;
    }
    let ctrlRows = "";
    for (const [ctrl, stats] of Object.entries(coverageByController)) {
      const pct = stats.total > 0 ? Math.round((stats.protected / stats.total) * 100) : 100;
      ctrlRows += `<tr><td>${escapeHtml(ctrl)}</td><td>${stats.total}</td><td>${stats.protected}</td><td><div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div> ${pct}%</td></tr>`;
    }
    return `<h3>By HTTP Method</h3>
    <table><thead><tr><th>Method</th><th>Total</th><th>Protected</th><th>Coverage</th></tr></thead><tbody>${methodRows}</tbody></table>
    <h3>By Controller</h3>
    <table><thead><tr><th>Controller</th><th>Total</th><th>Protected</th><th>Coverage</th></tr></thead><tbody>${ctrlRows}</tbody></table>`;
  };

  const renderCompleteness = (): string => {
    const c = manifest.completeness;
    if (!c) return "<p>Completeness metrics not available.</p>";
    const metrics = [
      { label: "Endpoint Resolution", value: c.endpointResolution, desc: "HTTP-relevant interactions with resolved endpoints" },
      { label: "Route Coverage", value: c.routeCoverage, desc: "Screens with mapped frontend routes" },
      { label: "Security Coverage", value: c.securityCoverage, desc: "Endpoints with roles or guards" },
      { label: "Entity Coverage", value: c.entityCoverage, desc: "Endpoints with entity mappings" },
      { label: "Controller Coverage", value: c.controllerCoverage, desc: "Endpoints with controller info" },
    ];
    let rows = "";
    for (const m of metrics) {
      const color = m.value >= 80 ? "#22c55e" : m.value >= 50 ? "#ca8a04" : "#dc2626";
      rows += `<tr>
        <td>${escapeHtml(m.label)}</td>
        <td>${escapeHtml(m.desc)}</td>
        <td><div class="progress-bar"><div class="progress-fill" style="width: ${m.value}%; background: ${color}"></div></div> ${m.value}%</td>
      </tr>`;
    }
    const overallColor = c.overallScore >= 80 ? "#22c55e" : c.overallScore >= 50 ? "#ca8a04" : "#dc2626";
    const b = c.interactionBreakdown;
    const breakdownHtml = b ? `
    <h3>Interaction Breakdown</h3>
    <div class="summary-grid" style="margin-bottom: 12px;">
      <div class="summary-card"><div class="value">${b.total}</div><div class="label">Total Interactions</div></div>
      <div class="summary-card"><div class="value">${b.withEndpoint}</div><div class="label">With HTTP Endpoint</div></div>
      <div class="summary-card"><div class="value">${b.uiOnly}</div><div class="label">UI-Only (State/Nav)</div></div>
      <div class="summary-card"><div class="value">${b.httpRelevant}</div><div class="label">HTTP-Relevant</div></div>
      <div class="summary-card"><div class="value">${b.httpRelevantResolved}</div><div class="label">HTTP Resolved</div></div>
    </div>` : "";
    return `<div class="summary-card" style="display: inline-block; margin-bottom: 16px;">
      <div class="value" style="color: ${overallColor}">${c.overallScore}%</div>
      <div class="label">Overall Completeness</div>
    </div>
    <table>
      <thead><tr><th>Metric</th><th>Description</th><th>Coverage</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${breakdownHtml}`;
  };

  const renderChecklist = (): string => {
    let items = "";
    for (const item of checklistItems) {
      items += `<div class="checklist-item ${item.pass ? "pass" : "fail"}">
        <span class="check-icon">${item.pass ? "&#10003;" : "&#10007;"}</span>
        <span>${escapeHtml(item.label)}</span>
      </div>`;
    }
    return items;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compliance Report - ${escapeHtml(project.name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.6; background: #fff; }
  .container { max-width: 1100px; margin: 0 auto; padding: 40px 32px; }
  .header { text-align: center; border-bottom: 3px solid #1a1a2e; padding-bottom: 24px; margin-bottom: 32px; }
  .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
  .header .subtitle { font-size: 14px; color: #555; }
  .header .logo { font-size: 20px; font-weight: 800; letter-spacing: 1px; color: #1a1a2e; margin-bottom: 8px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .summary-card { background: #f8f9fa; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 32px; font-weight: 700; color: #1a1a2e; }
  .summary-card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  section { margin-bottom: 40px; page-break-inside: avoid; }
  h2 { font-size: 20px; font-weight: 700; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 16px; color: #1a1a2e; }
  h3 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
  th { background: #f1f5f9; font-weight: 600; text-align: left; padding: 8px 10px; border: 1px solid #e2e8f0; }
  td { padding: 6px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .matrix td, .matrix th { text-align: center; padding: 4px 6px; font-size: 12px; }
  .matrix td:first-child, .matrix th:first-child { text-align: left; }
  .access-yes { background: #dcfce7; color: #166534; font-weight: 700; }
  .access-no { background: #fef2f2; color: #991b1b; }
  th.rotate { writing-mode: vertical-lr; text-orientation: mixed; max-width: 40px; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .badge.role { background: #dbeafe; color: #1e40af; }
  .badge.none { background: #fee2e2; color: #991b1b; }
  .badge.sensitive { background: #fee2e2; color: #991b1b; }
  .badge.safe { background: #dcfce7; color: #166534; }
  .badge.criticality-critical { background: #dc2626; color: #fff; }
  .badge.criticality-high { background: #ea580c; color: #fff; }
  .badge.criticality-medium { background: #ca8a04; color: #fff; }
  .badge.criticality-low { background: #2563eb; color: #fff; }
  .finding { border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
  .finding-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .finding-id { font-size: 12px; color: #888; margin-left: auto; }
  .severity-badge { display: inline-block; padding: 2px 10px; border-radius: 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .recommendation { background: #f0fdf4; border-left: 3px solid #22c55e; padding: 8px 12px; margin-top: 8px; font-size: 13px; }
  .affected { margin-top: 8px; font-size: 13px; }
  .progress-bar { display: inline-block; width: 80px; height: 10px; background: #e2e8f0; border-radius: 5px; vertical-align: middle; margin-right: 6px; }
  .progress-fill { height: 100%; background: #22c55e; border-radius: 5px; }
  .checklist-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .checklist-item.pass .check-icon { color: #16a34a; font-weight: 700; font-size: 16px; }
  .checklist-item.fail .check-icon { color: #dc2626; font-weight: 700; font-size: 16px; }
  .footer { text-align: center; border-top: 2px solid #e2e8f0; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #888; }
  @media print {
    body { font-size: 11px; }
    .container { padding: 20px; }
    section { page-break-inside: avoid; }
    h2 { page-break-after: avoid; }
    .finding { page-break-inside: avoid; }
    .summary-grid { page-break-inside: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">MANIFEST</div>
    <h1>SOC2 / LGPD Compliance Report</h1>
    <div class="subtitle">Project: ${escapeHtml(project.name)} | Generated: ${generatedAt} | Analyzed: ${escapeHtml(project.analyzedAt)}</div>
  </div>

  <div class="summary-grid">
    <div class="summary-card"><div class="value">${totalEndpoints}</div><div class="label">Total Endpoints</div></div>
    <div class="summary-card"><div class="value">${securityCoverage}%</div><div class="label">Security Coverage</div></div>
    <div class="summary-card"><div class="value">${rolesCount}</div><div class="label">Roles Defined</div></div>
    <div class="summary-card"><div class="value">${entitiesCount}</div><div class="label">Entities</div></div>
    <div class="summary-card"><div class="value" style="color: ${criticalFindings > 0 ? "#dc2626" : "#16a34a"}">${criticalFindings}</div><div class="label">Critical Findings</div></div>
  </div>

  <section>
    <h2>Section 1 &mdash; Endpoint Inventory</h2>
    ${renderEndpointTable()}
  </section>

  <section>
    <h2>Section 2 &mdash; Access Control Matrix</h2>
    ${renderAccessMatrix()}
  </section>

  <section>
    <h2>Section 3 &mdash; Personal Data Processing (LGPD Art. 37)</h2>
    ${renderPersonalData()}
  </section>

  <section>
    <h2>Section 4 &mdash; Security Findings</h2>
    ${renderFindings()}
  </section>

  <section>
    <h2>Section 5 &mdash; Security Coverage Metrics</h2>
    <div class="summary-card" style="display: inline-block; margin-bottom: 16px;">
      <div class="value">${securityCoverage}%</div>
      <div class="label">Overall Coverage</div>
    </div>
    ${renderCoverageMetrics()}
  </section>

  <section>
    <h2>Section 6 &mdash; Analysis Completeness</h2>
    ${renderCompleteness()}
  </section>

  <section>
    <h2>Section 7 &mdash; Compliance Checklist</h2>
    <div class="checklist">
      ${renderChecklist()}
    </div>
  </section>

  <div class="footer">
    Generated by Manifest v1.0.0 &mdash; This report is auto-generated from source code analysis
  </div>
</div>
</body>
</html>`;
}
