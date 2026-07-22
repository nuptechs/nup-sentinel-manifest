// Declaração mínima do pacote `diff@4` (sem tipos publicados) — só o que usamos.
declare module "diff" {
  export function createTwoFilesPatch(
    oldFile: string,
    newFile: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;
}
