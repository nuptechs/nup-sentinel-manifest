import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { storage } from "../storage";

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `pk_${crypto.randomBytes(32).toString("hex")}`;
  const prefix = raw.slice(0, 11);
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization as string | undefined;

  if (!authHeader || !authHeader.startsWith("Bearer pk_")) {
    return next();
  }

  const rawKey = authHeader.slice(7);
  const keyHash = hashApiKey(rawKey);

  storage.getApiKeyByHash(keyHash).then((apiKey) => {
    if (!apiKey) {
      return res.status(401).json({ message: "Invalid API key" });
    }

    if (apiKey.projectScope) {
      const projectIdParam = (req.params.projectId || req.params.id) as string | undefined;
      if (projectIdParam && parseInt(projectIdParam) !== apiKey.projectScope) {
        return res.status(403).json({ message: "API key does not have access to this project" });
      }
    }

    storage.updateApiKeyLastUsed(apiKey.id).catch(() => {});

    (req as any).apiKeyAuth = true;
    (req as any).apiKey = apiKey;
    next();
  }).catch(() => {
    res.status(500).json({ message: "Authentication error" });
  });
}
