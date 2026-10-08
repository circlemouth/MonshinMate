const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { SUPPORTED, digest, repairOptionalIndexSignatures, patchReviewedDeclaration } = require('../scripts/patch-chakra-theme-types.cjs');

function diagnostics(source) {
  const filename = path.resolve(__dirname, '../src/__chakra-patch-regression.ts');
  const options = { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2020 };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, createNew) => file === filename
    ? ts.createSourceFile(filename, source, language, true)
    : original(file, language, onError, createNew);
  return ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host)).filter(item => item.file?.fileName === filename);
}

test('AST repair addresses only undefined optional/index mismatch while genuine invalid types still fail', () => {
  const source = `
    type ThemeScope = { [x: string]: string; inactive?: undefined; label: string };
    type RealInvalidScope = { [x: string]: string; count: number };
    const wrong: ThemeScope = { label: 42 };
  `;
  assert.equal(diagnostics(source).length, 3);
  const repaired = repairOptionalIndexSignatures(source);
  assert.equal(repaired.scopes, 1);
  assert.match(repaired.source, /\[x: string\]: string \| undefined; inactive\?: undefined/);
  assert.match(repaired.source, /\[x: string\]: string; count: number/);
  const remaining = diagnostics(repaired.source);
  assert.deepEqual(remaining.map(item => item.code).sort(), [2322, 2411]);
  assert.equal(repairOptionalIndexSignatures(repaired.source).scopes, 0);
});

test('declaration patch rejects unreviewed versions and even one-byte content changes', () => {
  assert.throws(() => patchReviewedDeclaration('type Changed = {}', '999.0.0'), /Unreviewed Chakra theme version/);
  assert.throws(() => patchReviewedDeclaration('type Changed = {}', SUPPORTED.version), /Unreviewed Chakra theme declaration content/);
});

test('installed reviewed declarations are patched idempotently without changing runtime JS', () => {
  const entry = require.resolve('@chakra-ui/theme');
  const packageDir = path.resolve(path.dirname(entry), '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const declaration = path.join(packageDir, 'dist/types/index.d.ts');
  const source = fs.readFileSync(declaration, 'utf8');
  assert.equal(pkg.version, SUPPORTED.version);
  assert.equal(digest(source), SUPPORTED.patched, 'npm ci postinstall applies the reviewed patch');
  assert.equal(patchReviewedDeclaration(source, pkg.version).scopes, 0);
  assert.throws(() => patchReviewedDeclaration(source + '\n', pkg.version), /Unreviewed Chakra theme declaration content/);
  const runtimeBefore = fs.readFileSync(entry);
  const declarationBefore = fs.readFileSync(declaration);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/patch-chakra-theme-types.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 reviewed declaration scopes/);
  assert.deepEqual(fs.readFileSync(entry), runtimeBefore);
  assert.deepEqual(fs.readFileSync(declaration), declarationBefore);
  assert.equal(SUPPORTED.scopes, 11);
});
