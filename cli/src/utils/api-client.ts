import fetch from 'node-fetch';
import * as fs from 'fs';
import FormData from 'form-data';

export interface AnalyzeFile {
  path: string;
  content: string;
}

export class PermaCatClient {
  private serverUrl: string;
  private apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.serverUrl}${path}`;
    const opts: any = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  async analyze(files: AnalyzeFile[], options?: { format?: string }): Promise<any> {
    const body: any = { files };
    if (options?.format) {
      body.format = options.format;
    }
    return this.request('POST', '/api/analyze', body);
  }

  async analyzeZip(zipPath: string, options?: { format?: string }): Promise<any> {
    const url = `${this.serverUrl}/api/analyze-zip`;
    const form = new FormData();
    form.append('file', fs.createReadStream(zipPath));
    if (options?.format) {
      form.append('format', options.format);
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async getManifest(projectId: number, format: string): Promise<any> {
    return this.request('GET', `/api/manifest/${projectId}?format=${encodeURIComponent(format)}`);
  }

  async getDiff(projectId: number, runA: number, runB: number): Promise<any> {
    return this.request('GET', `/api/projects/${projectId}/diff?runA=${runA}&runB=${runB}`);
  }

  async getLatestDiff(projectId: number): Promise<any> {
    return this.request('GET', `/api/projects/${projectId}/diff/latest`);
  }

  async getProjects(): Promise<any> {
    return this.request('GET', '/api/projects');
  }

  async getSnapshots(projectId: number): Promise<any> {
    return this.request('GET', `/api/projects/${projectId}/snapshots`);
  }

  async connectGit(projectId: number, provider: string, repoUrl: string, token: string): Promise<any> {
    return this.request('POST', `/api/projects/${projectId}/git/connect`, {
      provider,
      repoUrl,
      token,
    });
  }
}
