import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { ManifestClient, AnalyzeFile } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';
import { formatTable, formatSummary, formatJson } from '../utils/output';

const SUPPORTED_EXTENSIONS = new Set(['.java', '.vue', '.tsx', '.jsx', '.ts', '.js', '.html']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', '__pycache__']);
const MAX_FILES = 5000;

const INTERACTION_PATTERNS = [
  { pattern: /@(Get|Post|Put|Delete|Patch)Mapping/g, type: 'spring-endpoint' },
  { pattern: /@RequestMapping/g, type: 'spring-endpoint' },
  { pattern: /app\.(get|post|put|delete|patch)\s*\(/g, type: 'express-endpoint' },
  { pattern: /router\.(get|post|put|delete|patch)\s*\(/g, type: 'express-endpoint' },
  { pattern: /fetch\s*\(/g, type: 'http-call' },
  { pattern: /axios\.(get|post|put|delete|patch)\s*\(/g, type: 'http-call' },
  { pattern: /\$http\.(get|post|put|delete|patch)\s*\(/g, type: 'http-call' },
  { pattern: /@PreAuthorize/g, type: 'security-annotation' },
  { pattern: /@Secured/g, type: 'security-annotation' },
  { pattern: /@RolesAllowed/g, type: 'security-annotation' },
];

function scanDirectory(dirPath: string): AnalyzeFile[] {
  const files: AnalyzeFile[] = [];

  function walk(currentPath: string): void {
    if (files.length >= MAX_FILES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;

      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            files.push({
              path: path.relative(dirPath, fullPath),
              content,
            });
          } catch {
          }
        }
      }
    }
  }

  walk(dirPath);

  if (files.length >= MAX_FILES) {
    console.warn(chalk.yellow(`Warning: File limit reached (${MAX_FILES}). Some files may be skipped.`));
  }

  return files;
}

function localAnalyze(files: AnalyzeFile[]): any {
  const interactions: any[] = [];

  for (const file of files) {
    for (const { pattern, type } of INTERACTION_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) !== null) {
        const lineNum = file.content.substring(0, match.index).split('\n').length;
        interactions.push({
          file: file.path,
          line: lineNum,
          type,
          match: match[0],
          criticalityScore: type === 'security-annotation' ? 2 : type === 'express-endpoint' || type === 'spring-endpoint' ? 5 : 3,
        });
      }
    }
  }

  return {
    projectName: 'local-analysis',
    filesAnalyzed: files.length,
    interactions,
    endpoints: interactions.filter((i) => i.type.includes('endpoint')),
  };
}

export function createAnalyzeCommand(): Command {
  const cmd = new Command('analyze')
    .description('Analyze source code for permissions and interactions')
    .argument('<path>', 'Path to source directory or zip file')
    .option('-f, --format <format>', 'Analysis format', 'manifest')
    .option('-o, --output <mode>', 'Output mode: json, table, or summary', 'summary')
    .option('--zip', 'Treat path as a zip file')
    .option('--local', 'Run local analysis without server')
    .action(async (targetPath: string, options: any, command: Command) => {
      try {
        const globalOpts = command.parent?.opts() || {};
        const resolvedPath = path.resolve(targetPath);

        if (!fs.existsSync(resolvedPath)) {
          console.error(chalk.red(`Error: Path not found: ${resolvedPath}`));
          process.exit(2);
        }

        let result: any;

        if (options.local) {
          const spinner = ora('Scanning files locally...').start();
          const files = scanDirectory(resolvedPath);
          spinner.text = `Analyzing ${files.length} files...`;
          result = localAnalyze(files);
          spinner.succeed(`Analyzed ${files.length} files locally`);
        } else {
          const config = mergeConfig(globalOpts, loadConfig(globalOpts.config));
          const client = new ManifestClient(config.serverUrl, config.apiKey);

          if (options.zip) {
            const spinner = ora('Uploading and analyzing zip file...').start();
            try {
              result = await client.analyzeZip(resolvedPath, { format: options.format });
              spinner.succeed('Zip analysis complete');
            } catch (err: any) {
              spinner.fail('Zip analysis failed');
              console.error(chalk.red(err.message));
              process.exit(2);
            }
          } else {
            const spinner = ora('Scanning files...').start();
            const files = scanDirectory(resolvedPath);
            spinner.text = `Uploading ${files.length} files for analysis...`;
            try {
              result = await client.analyze(files, { format: options.format });
              spinner.succeed(`Analysis complete (${files.length} files)`);
            } catch (err: any) {
              spinner.fail('Analysis failed');
              console.error(chalk.red(err.message));
              process.exit(2);
            }
          }
        }

        switch (options.output) {
          case 'json':
            console.log(formatJson(result));
            break;
          case 'table': {
            const endpoints = result.endpoints || result.interactions || [];
            if (endpoints.length === 0) {
              console.log(chalk.yellow('No endpoints or interactions found.'));
            } else {
              console.log(
                formatTable(endpoints, [
                  { key: 'file', label: 'File' },
                  { key: 'type', label: 'Type' },
                  { key: 'match', label: 'Match' },
                  { key: 'line', label: 'Line' },
                  { key: 'criticalityScore', label: 'Criticality' },
                ])
              );
            }
            break;
          }
          case 'summary':
          default:
            console.log(formatSummary(result));
            break;
        }

        const endpoints = result.endpoints || result.interactions || [];
        const hasHighCriticality = endpoints.some(
          (ep: any) => (ep.criticalityScore ?? ep.criticality ?? 0) >= 8 && !ep.authRequired && !ep.securityAnnotations?.length
        );
        process.exit(hasHighCriticality ? 1 : 0);
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(2);
      }
    });

  return cmd;
}
