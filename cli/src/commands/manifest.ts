import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { PermaCatClient } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';
import { formatManifest, formatJson } from '../utils/output';

export function createManifestCommand(): Command {
  const cmd = new Command('manifest')
    .description('Retrieve and display project permission manifest')
    .argument('<projectId>', 'Project ID')
    .option('-f, --format <format>', 'Manifest format: manifest, agents-md, openapi, policy-matrix, all', 'manifest')
    .option('--output-file <path>', 'Write output to file instead of stdout')
    .action(async (projectId: string, options: any, command: Command) => {
      try {
        const globalOpts = command.parent?.opts() || {};
        const config = mergeConfig(globalOpts, loadConfig(globalOpts.config));
        const client = new PermaCatClient(config.serverUrl, config.apiKey);
        const pid = parseInt(projectId, 10);

        if (isNaN(pid)) {
          console.error(chalk.red('Error: projectId must be a number'));
          process.exit(2);
        }

        const spinner = ora(`Fetching ${options.format} manifest...`).start();

        let result: any;
        try {
          result = await client.getManifest(pid, options.format);
          spinner.succeed('Manifest retrieved');
        } catch (err: any) {
          spinner.fail('Failed to retrieve manifest');
          console.error(chalk.red(err.message));
          process.exit(2);
        }

        const output = typeof result === 'string' ? result : formatManifest(result, options.format);

        if (options.outputFile) {
          fs.writeFileSync(options.outputFile, output, 'utf-8');
          console.log(chalk.green(`Manifest written to ${options.outputFile}`));
        } else {
          console.log(output);
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(2);
      }
    });

  return cmd;
}
