import * as https from "https";
import * as http from "http";

export interface AnalysisResult {
  interactions?: any[];
  endpoints?: any[];
  screens?: any[];
  security?: any[];
  summary?: {
    totalInteractions: number;
    totalEndpoints: number;
    coveragePercent: number;
    avgCriticality: number;
  };
  [key: string]: any;
}

export class RemoteAnalyzer {
  private serverUrl: string;
  private apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async analyzeFiles(files: { path: string; content: string }[]): Promise<AnalysisResult> {
    const url = this.serverUrl + "/api/analyze";
    const body = JSON.stringify({ files, options: { format: "all" } });

    const response = await this.request("POST", url, body);

    if (!response.ok) {
      throw new Error(`Analysis failed: ${response.status} ${response.statusText} - ${response.body}`);
    }

    try {
      return JSON.parse(response.body);
    } catch {
      throw new Error(`Invalid JSON response from server: ${response.body.substring(0, 200)}`);
    }
  }

  async getManifest(projectId: number, format: string): Promise<any> {
    const url = `${this.serverUrl}/api/manifest/${projectId}?format=${encodeURIComponent(format)}`;

    const response = await this.request("GET", url);

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    try {
      return JSON.parse(response.body);
    } catch {
      throw new Error(`Invalid JSON response from server: ${response.body.substring(0, 200)}`);
    }
  }

  private request(method: string, url: string, body?: string): Promise<{ ok: boolean; status: number; statusText: string; body: string }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
      };

      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      if (body) {
        headers["Content-Length"] = Buffer.byteLength(body).toString();
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      const req = transport.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            body: data,
          });
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Network error connecting to ${url}: ${err.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error(`Request to ${url} timed out after 30 seconds`));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}
