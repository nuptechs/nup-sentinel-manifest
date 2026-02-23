import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PermaCatConfig {
  serverUrl: string;
  apiKey: string;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.permacat.json');

export function loadConfig(configPath?: string): Partial<PermaCatConfig> {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Partial<PermaCatConfig>;
    }
  } catch {
  }
  return {};
}

export function saveConfig(config: Partial<PermaCatConfig>, configPath?: string): void {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const existing = loadConfig(filePath);
  const merged = { ...existing, ...config };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
}

export function mergeConfig(
  cliOptions: { server?: string; key?: string },
  fileConfig: Partial<PermaCatConfig>
): PermaCatConfig {
  return {
    serverUrl: cliOptions.server || fileConfig.serverUrl || 'http://localhost:5000',
    apiKey: cliOptions.key || fileConfig.apiKey || '',
  };
}
