#!/usr/bin/env node
import { Command } from 'commander';
import { createAnalyzeCommand } from './commands/analyze';
import { createDiffCommand } from './commands/diff';
import { createManifestCommand } from './commands/manifest';
import { createConnectCommand } from './commands/connect';

const program = new Command();

program
  .name('nup-manifest')
  .description('Manifest CLI - Code-to-Permission Catalog Generator')
  .version('0.1.0')
  .option('--server <url>', 'Manifest server URL', 'http://localhost:5000')
  .option('--key <apiKey>', 'API key for authentication')
  .option('--config <path>', 'Path to config file', '~/.nup-manifest.json');

program.addCommand(createAnalyzeCommand());
program.addCommand(createDiffCommand());
program.addCommand(createManifestCommand());
program.addCommand(createConnectCommand());

program.parse(process.argv);
