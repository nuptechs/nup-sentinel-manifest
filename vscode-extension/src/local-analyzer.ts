export interface Interaction {
  filePath: string;
  line: number;
  handlerName: string;
  eventType: string;
  httpMethod?: string;
  httpUrl?: string;
  framework: string;
}

export class LocalAnalyzer {
  analyzeFile(filePath: string, content: string): Interaction[] {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const lines = content.split("\n");
    const interactions: Interaction[] = [];

    if (ext === "vue") {
      interactions.push(...this.analyzeVue(filePath, lines));
    } else if (["tsx", "jsx"].includes(ext)) {
      interactions.push(...this.analyzeReact(filePath, lines));
    } else if (ext === "ts" || ext === "js") {
      if (this.looksLikeAngular(content)) {
        interactions.push(...this.analyzeAngular(filePath, lines));
      } else {
        interactions.push(...this.analyzeReact(filePath, lines));
      }
    }

    interactions.push(...this.analyzeHttpCalls(filePath, lines, this.detectFramework(ext, content)));

    return interactions;
  }

  analyzeWorkspace(files: { path: string; content: string }[]): Interaction[] {
    const results: Interaction[] = [];
    for (const file of files) {
      results.push(...this.analyzeFile(file.path, file.content));
    }
    return results;
  }

  private detectFramework(ext: string, content: string): string {
    if (ext === "vue") return "vue";
    if (this.looksLikeAngular(content)) return "angular";
    return "react";
  }

  private looksLikeAngular(content: string): boolean {
    return /@Component\s*\(/.test(content) || /@NgModule\s*\(/.test(content);
  }

  private analyzeVue(filePath: string, lines: string[]): Interaction[] {
    const interactions: Interaction[] = [];
    const vueEventPattern = /(?:@|v-on:)(click|submit|change|input|keyup|keydown|focus|blur)(?:\.[\w.]+)?="([^"]+)"/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;
      vueEventPattern.lastIndex = 0;
      while ((match = vueEventPattern.exec(line)) !== null) {
        const handlerRaw = match[2].replace(/\(.*\)/, "").trim();
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: handlerRaw,
          eventType: match[1],
          framework: "vue",
        });
      }
    }

    return interactions;
  }

  private analyzeReact(filePath: string, lines: string[]): Interaction[] {
    const interactions: Interaction[] = [];
    const reactEventPattern = /on(Click|Submit|Change|Input|KeyUp|KeyDown|Focus|Blur)=\{([^}]+)\}/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;
      reactEventPattern.lastIndex = 0;
      while ((match = reactEventPattern.exec(line)) !== null) {
        const handlerRaw = match[2].replace(/\(.*\)/, "").trim();
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: handlerRaw,
          eventType: match[1].toLowerCase(),
          framework: "react",
        });
      }
    }

    return interactions;
  }

  private analyzeAngular(filePath: string, lines: string[]): Interaction[] {
    const interactions: Interaction[] = [];
    const angularEventPattern = /\((click|submit|change|input|keyup|keydown|focus|blur)\)="([^"]+)"/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;
      angularEventPattern.lastIndex = 0;
      while ((match = angularEventPattern.exec(line)) !== null) {
        const handlerRaw = match[2].replace(/\(.*\)/, "").trim();
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: handlerRaw,
          eventType: match[1],
          framework: "angular",
        });
      }
    }

    return interactions;
  }

  private analyzeHttpCalls(filePath: string, lines: string[], framework: string): Interaction[] {
    const interactions: Interaction[] = [];

    const fetchPattern = /fetch\s*\(\s*[`'"]((?:GET|POST|PUT|DELETE|PATCH)\s+)?([^`'"]+)[`'"]/;
    const axiosPattern = /axios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*[`'"]([ ^`'"]+)[`'"]/;
    const httpClientPattern = /this\.http\s*\.\s*(get|post|put|delete|patch)\s*[<(]\s*[`'"]([ ^`'"]+)[`'"]/;
    const fetchMethodPattern = /method\s*:\s*[`'"](\w+)[`'"]/;
    const genericApiPattern = /(?:api|fetch|request)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*[`'"]([ ^`'"]+)[`'"]/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;

      match = fetchPattern.exec(line);
      if (match) {
        let method = "GET";
        const methodMatch = fetchMethodPattern.exec(lines.slice(Math.max(0, i - 2), i + 5).join("\n"));
        if (methodMatch) method = methodMatch[1].toUpperCase();
        if (match[1]) method = match[1].trim();

        interactions.push({
          filePath,
          line: i + 1,
          handlerName: "fetch",
          eventType: "http_call",
          httpMethod: method,
          httpUrl: match[2],
          framework,
        });
        continue;
      }

      match = axiosPattern.exec(line);
      if (match) {
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: "axios." + match[1],
          eventType: "http_call",
          httpMethod: match[1].toUpperCase(),
          httpUrl: match[2],
          framework,
        });
        continue;
      }

      match = httpClientPattern.exec(line);
      if (match) {
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: "HttpClient." + match[1],
          eventType: "http_call",
          httpMethod: match[1].toUpperCase(),
          httpUrl: match[2],
          framework,
        });
        continue;
      }

      match = genericApiPattern.exec(line);
      if (match) {
        interactions.push({
          filePath,
          line: i + 1,
          handlerName: "api." + match[1],
          eventType: "http_call",
          httpMethod: match[1].toUpperCase(),
          httpUrl: match[2],
          framework,
        });
      }
    }

    return interactions;
  }
}
