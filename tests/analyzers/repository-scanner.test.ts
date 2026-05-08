/**
 * Adversarial tests for the ZIP repository scanner.
 *
 * The scanner is the public entry point that consumes user-uploaded ZIP
 * archives. Hostile inputs that must not crash, leak paths, or smuggle
 * data past the ignore filters:
 *
 * - path traversal entries (`../../etc/passwd.java`)
 * - mixed path separators (`src\\App.ts`)
 * - empty / oversized / binary entries
 * - all-ignored extensions
 * - empty zip
 * - case-sensitivity of the IGNORED_DIRS list
 * - deeply nested ignored directories
 * - common-root stripping
 * - getFileType mapping
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore - adm-zip has no types
import AdmZip from "adm-zip";
import {
  extractAndScanZip,
  getFileType,
} from "../../server/analyzers/repository-scanner.ts";

function buildZip(entries: Array<{ name: string; content: Buffer | string }>): Buffer {
  const zip = new AdmZip();
  for (const e of entries) {
    const buf = typeof e.content === "string" ? Buffer.from(e.content, "utf-8") : e.content;
    zip.addFile(e.name, buf);
  }
  return zip.toBuffer();
}

describe("extractAndScanZip — happy path", () => {
  it("scans a normal zip and returns supported files", () => {
    const buf = buildZip([
      { name: "src/App.ts", content: "export const x = 1;" },
      { name: "src/App.test.ts", content: "// test" },
      { name: "README.md", content: "# unsupported extension" },
    ]);
    const files = extractAndScanZip(buf);
    const paths = files.map((f) => f.filePath).sort();
    // README.md prevents the `src/` common-root from being stripped because
    // the common-root detector runs over ALL entries (not just supported).
    assert.deepEqual(paths, ["src/App.test.ts", "src/App.ts"]);
  });

  it("strips a single common root folder", () => {
    const buf = buildZip([
      { name: "myrepo/a.ts", content: "a" },
      { name: "myrepo/sub/b.ts", content: "b" },
    ]);
    const files = extractAndScanZip(buf);
    assert.deepEqual(
      files.map((f) => f.filePath).sort(),
      ["a.ts", "sub/b.ts"]
    );
  });

  it("does not strip when files share no common root", () => {
    const buf = buildZip([
      { name: "a/x.ts", content: "x" },
      { name: "b/y.ts", content: "y" },
    ]);
    const files = extractAndScanZip(buf);
    const paths = files.map((f) => f.filePath).sort();
    assert.deepEqual(paths, ["a/x.ts", "b/y.ts"]);
  });
});

describe("extractAndScanZip — empty / degenerate input", () => {
  it("returns [] for an empty zip", () => {
    const buf = buildZip([]);
    assert.deepEqual(extractAndScanZip(buf), []);
  });

  it("returns [] when every entry has an unsupported extension", () => {
    const buf = buildZip([
      { name: "README.md", content: "x" },
      { name: "image.png", content: "x" },
      { name: "binary.exe", content: "x" },
    ]);
    assert.deepEqual(extractAndScanZip(buf), []);
  });

  it("skips empty (whitespace-only) supported files", () => {
    const buf = buildZip([
      { name: "src/empty.ts", content: "   \n\t  " },
      { name: "src/real.ts", content: "export {}" },
    ]);
    const files = extractAndScanZip(buf);
    assert.equal(files.length, 1);
    assert.equal(files[0].filePath, "real.ts");
  });
});

describe("extractAndScanZip — ignore rules", () => {
  it("ignores entries inside well-known dependency folders", () => {
    const buf = buildZip([
      { name: "node_modules/lib/index.ts", content: "noop" },
      { name: ".git/HEAD", content: "x" }, // unsupported ext anyway
      { name: "dist/app.js", content: "compiled" },
      { name: "src/keep.ts", content: "keep" },
    ]);
    const files = extractAndScanZip(buf);
    assert.deepEqual(
      files.map((f) => f.filePath),
      ["src/keep.ts"]
    );
  });

  it("ignores deeply nested IGNORED_DIRS segments", () => {
    const buf = buildZip([
      { name: "packages/a/node_modules/lib/x.ts", content: "x" },
      { name: "packages/a/src/x.ts", content: "x" },
    ]);
    const files = extractAndScanZip(buf);
    // Common-root stripping is single-level (only `packages/` is shared);
    // the nested `node_modules/` is still detected and rejected.
    assert.deepEqual(
      files.map((f) => f.filePath),
      ["a/src/x.ts"]
    );
  });

  it("ignore set is case-sensitive (NODE_MODULES is treated as a normal folder)", () => {
    // This documents current behaviour. If a future hardening makes the
    // ignore set case-insensitive, flip the assertion.
    const buf = buildZip([
      { name: "NODE_MODULES/lib.ts", content: "x" },
      { name: "src/keep.ts", content: "x" },
    ]);
    const files = extractAndScanZip(buf);
    const paths = files.map((f) => f.filePath).sort();
    assert.deepEqual(paths, ["NODE_MODULES/lib.ts", "src/keep.ts"]);
  });

  it("respects MAX_FILE_SIZE (512 KB) — oversized entries are dropped", () => {
    const big = "x".repeat(513 * 1024);
    const buf = buildZip([
      { name: "src/big.ts", content: big },
      { name: "src/small.ts", content: "ok" },
    ]);
    const files = extractAndScanZip(buf);
    assert.deepEqual(
      files.map((f) => f.filePath),
      ["small.ts"]
    );
  });

  it("normalises Windows-style backslash separators", () => {
    const buf = buildZip([
      { name: "src\\App.ts", content: "x" },
      { name: "src\\sub\\B.ts", content: "y" },
    ]);
    const files = extractAndScanZip(buf);
    const paths = files.map((f) => f.filePath).sort();
    assert.deepEqual(paths, ["App.ts", "sub/B.ts"]);
  });
});

describe("extractAndScanZip — adversarial / hostile entries", () => {
  it("does not crash on path traversal entries and never returns a path that escapes the archive root", () => {
    const buf = buildZip([
      { name: "../../etc/passwd.ts", content: "evil" },
      { name: "src/safe.ts", content: "ok" },
    ]);
    const files = extractAndScanZip(buf);
    // Whatever the scanner chooses to do with traversal entries, it MUST NOT
    // return a path that still contains `..` segments — that would propagate
    // a foothold to every downstream consumer (graph builder, semantic
    // engine, persistence layer).
    for (const f of files) {
      const segs = f.filePath.split("/");
      assert.ok(
        !segs.includes(".."),
        `traversal segment leaked through scanner: ${f.filePath}`
      );
    }
    // The benign file must survive.
    assert.ok(files.some((f) => f.filePath.endsWith("safe.ts")));
  });

  it("rejects or sanitises NUL bytes in entry names", () => {
    const buf = buildZip([
      { name: "src/bad\u0000.ts", content: "x" },
      { name: "src/good.ts", content: "x" },
    ]);
    const files = extractAndScanZip(buf);
    for (const f of files) {
      assert.ok(
        !f.filePath.includes("\u0000"),
        `NUL byte leaked through scanner: ${JSON.stringify(f.filePath)}`
      );
    }
  });

  it("treats binary entries forced to utf-8 as opaque content without crashing", () => {
    // Random non-utf8 bytes (lone surrogate-equivalent pattern in latin1).
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0xc0, 0xc1, 0xff]);
    const buf = buildZip([
      { name: "src/binary.ts", content: binary },
      { name: "src/text.ts", content: "ok" },
    ]);
    // Must not throw, regardless of how the bytes decode.
    const files = extractAndScanZip(buf);
    assert.ok(files.length >= 1);
    assert.ok(files.some((f) => f.filePath.endsWith("text.ts")));
  });

  it("normalises supported-extension case to lowercase before matching", () => {
    const buf = buildZip([
      { name: "src/App.TS", content: "x" },
      { name: "src/Other.JAVA", content: "x" },
    ]);
    const files = extractAndScanZip(buf);
    assert.equal(files.length, 2);
  });
});

describe("getFileType", () => {
  for (const [ext, type] of [
    [".java", "java"],
    [".vue", "vue"],
    [".jsx", "react"],
    [".tsx", "react"],
    [".ts", "typescript"],
    [".js", "javascript"],
    [".py", "python"],
    [".cs", "csharp"],
  ] as const) {
    it(`maps ${ext} → ${type}`, () => {
      assert.equal(getFileType(`some/file${ext}`), type);
    });
  }

  it("returns 'other' for unknown extensions", () => {
    assert.equal(getFileType("README.md"), "other");
    assert.equal(getFileType("noext"), "other");
  });

  it("is case-insensitive on the extension", () => {
    assert.equal(getFileType("App.TS"), "typescript");
    assert.equal(getFileType("App.JAVA"), "java");
  });
});
