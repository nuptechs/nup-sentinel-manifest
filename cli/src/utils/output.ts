import chalk from 'chalk';
import Table from 'cli-table3';

export function formatTable(data: Record<string, any>[], columns: { key: string; label: string }[]): string {
  const table = new Table({
    head: columns.map((c) => chalk.bold(c.label)),
    style: { head: [], border: [] },
  });
  for (const row of data) {
    table.push(columns.map((c) => String(row[c.key] ?? '')));
  }
  return table.toString();
}

export function formatSummary(result: any): string {
  const lines: string[] = [];
  lines.push(chalk.bold.underline('Analysis Summary'));
  lines.push('');

  if (result.projectName) {
    lines.push(`Project: ${chalk.cyan(result.projectName)}`);
  }

  const endpoints = result.endpoints || result.interactions || [];
  const totalEndpoints = endpoints.length;
  let highCriticality = 0;
  let mediumCriticality = 0;
  let lowCriticality = 0;
  let unprotected = 0;

  for (const ep of endpoints) {
    const score = ep.criticalityScore ?? ep.criticality ?? 0;
    if (score >= 8) highCriticality++;
    else if (score >= 5) mediumCriticality++;
    else lowCriticality++;

    if (!ep.authRequired && !ep.securityAnnotations?.length) {
      unprotected++;
    }
  }

  lines.push(`Total Endpoints: ${chalk.bold(String(totalEndpoints))}`);
  lines.push(`  ${severityColor(8)('High Criticality')}: ${highCriticality}`);
  lines.push(`  ${severityColor(5)('Medium Criticality')}: ${mediumCriticality}`);
  lines.push(`  ${severityColor(0)('Low Criticality')}: ${lowCriticality}`);

  if (unprotected > 0) {
    lines.push('');
    lines.push(chalk.red.bold(`Unprotected Endpoints: ${unprotected}`));
  }

  if (result.filesAnalyzed !== undefined) {
    lines.push('');
    lines.push(`Files Analyzed: ${result.filesAnalyzed}`);
  }

  return lines.join('\n');
}

export function formatJson(data: any): string {
  return JSON.stringify(data, null, 2);
}

export function formatManifest(manifest: any, format: string): string {
  if (typeof manifest === 'string') {
    return manifest;
  }
  return JSON.stringify(manifest, null, 2);
}

export function severityColor(score: number): chalk.Chalk {
  if (score >= 8) return chalk.red;
  if (score >= 5) return chalk.yellow;
  return chalk.green;
}
