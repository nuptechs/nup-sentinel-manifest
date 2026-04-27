import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ManifestClient } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';

export function createConnectCommand(): Command {
  const cmd = new Command('connect')
    .description('Connect a Git repository to a Manifest project')
    .argument('<repoUrl>', 'Git repository URL')
    .requiredOption('--provider <provider>', 'Git provider: github or gitlab')
    .requiredOption('--token <token>', 'Git access token')
    .requiredOption('--project <projectId>', 'Manifest project ID')
    .action(async (repoUrl: string, options: any, command: Command) => {
      try {
        const globalOpts = command.parent?.opts() || {};
        const config = mergeConfig(globalOpts, loadConfig(globalOpts.config));
        const client = new ManifestClient(config.serverUrl, config.apiKey);
        const pid = parseInt(options.project, 10);

        if (isNaN(pid)) {
          console.error(chalk.red('Error: project ID must be a number'));
          process.exit(2);
        }

        if (!['github', 'gitlab'].includes(options.provider)) {
          console.error(chalk.red('Error: provider must be "github" or "gitlab"'));
          process.exit(2);
        }

        const spinner = ora('Connecting repository...').start();

        let result: any;
        try {
          result = await client.connectGit(pid, options.provider, repoUrl, options.token);
          spinner.succeed('Repository connected successfully');
        } catch (err: any) {
          spinner.fail('Failed to connect repository');
          console.error(chalk.red(err.message));
          process.exit(2);
        }

        console.log('');
        console.log(chalk.green(`Repository: ${repoUrl}`));
        console.log(chalk.green(`Provider: ${options.provider}`));
        console.log(chalk.green(`Project ID: ${pid}`));

        if (result.branches && Array.isArray(result.branches)) {
          console.log('');
          console.log(chalk.bold('Available Branches:'));
          for (const branch of result.branches) {
            console.log(`  - ${branch}`);
          }
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(2);
      }
    });

  return cmd;
}
