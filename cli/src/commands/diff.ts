import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { PermaCatClient } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';
import { formatTable, formatJson, severityColor } from '../utils/output';

export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Compare analysis snapshots to detect permission changes')
    .argument('<projectId>', 'Project ID')
    .argument('[runA]', 'First snapshot run ID')
    .argument('[runB]', 'Second snapshot run ID')
    .option('-o, --output <mode>', 'Output mode: json, table, or summary', 'summary')
    .action(async (projectId: string, runA: string | undefined, runB: string | undefined, options: any, command: Command) => {
      try {
        const globalOpts = command.parent?.opts() || {};
        const config = mergeConfig(globalOpts, loadConfig(globalOpts.config));
        const client = new PermaCatClient(config.serverUrl, config.apiKey);
        const pid = parseInt(projectId, 10);

        if (isNaN(pid)) {
          console.error(chalk.red('Error: projectId must be a number'));
          process.exit(2);
        }

        const spinner = ora('Fetching diff...').start();

        let result: any;
        try {
          if (runA && runB) {
            result = await client.getDiff(pid, parseInt(runA, 10), parseInt(runB, 10));
          } else {
            result = await client.getLatestDiff(pid);
          }
          spinner.succeed('Diff retrieved');
        } catch (err: any) {
          spinner.fail('Failed to retrieve diff');
          console.error(chalk.red(err.message));
          process.exit(2);
        }

        switch (options.output) {
          case 'json':
            console.log(formatJson(result));
            break;
          case 'table': {
            const changes: any[] = [];
            if (result.added) {
              for (const item of result.added) {
                changes.push({ status: 'Added', ...item });
              }
            }
            if (result.removed) {
              for (const item of result.removed) {
                changes.push({ status: 'Removed', ...item });
              }
            }
            if (result.modified) {
              for (const item of result.modified) {
                changes.push({ status: 'Modified', ...item });
              }
            }
            if (changes.length === 0) {
              console.log(chalk.green('No changes detected.'));
            } else {
              console.log(
                formatTable(changes, [
                  { key: 'status', label: 'Status' },
                  { key: 'endpoint', label: 'Endpoint' },
                  { key: 'method', label: 'Method' },
                  { key: 'criticalityScore', label: 'Criticality' },
                ])
              );
            }
            break;
          }
          case 'summary':
          default: {
            console.log(chalk.bold.underline('Diff Summary'));
            console.log('');

            const added = result.added?.length || 0;
            const removed = result.removed?.length || 0;
            const modified = result.modified?.length || 0;
            const total = added + removed + modified;

            console.log(`Total Changes: ${chalk.bold(String(total))}`);
            console.log(`  ${chalk.green('Added')}: ${added}`);
            console.log(`  ${chalk.red('Removed')}: ${removed}`);
            console.log(`  ${chalk.yellow('Modified')}: ${modified}`);

            if (result.securityImpact !== undefined) {
              const score = result.securityImpact;
              console.log('');
              console.log(`Security Impact: ${severityColor(score)(String(score))}`);
            }

            if (result.added?.length) {
              console.log('');
              console.log(chalk.green.bold('Added Endpoints:'));
              for (const item of result.added) {
                console.log(chalk.green(`  + ${item.method || ''} ${item.endpoint || item.path || ''}`));
              }
            }

            if (result.removed?.length) {
              console.log('');
              console.log(chalk.red.bold('Removed Endpoints:'));
              for (const item of result.removed) {
                console.log(chalk.red(`  - ${item.method || ''} ${item.endpoint || item.path || ''}`));
              }
            }

            if (result.modified?.length) {
              console.log('');
              console.log(chalk.yellow.bold('Modified Endpoints:'));
              for (const item of result.modified) {
                console.log(chalk.yellow(`  ~ ${item.method || ''} ${item.endpoint || item.path || ''}`));
              }
            }
            break;
          }
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(2);
      }
    });

  return cmd;
}
