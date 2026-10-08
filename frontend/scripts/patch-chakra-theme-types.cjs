// Chakra 3.4.10 generates 26 TS2411 errors: 11 type-literal index signatures
// omit undefined even though their own optional properties explicitly use it.
// Repair only these declaration scopes; never skip library checks or change JS.
// Updating Chakra requires reviewing new declaration content/hashes before install.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const SUPPORTED = Object.freeze({
  version: '3.4.10',
  original: '19d8f0ab567167adad81f6ca600cc879a3d9875d39b7ce6af66cc95ff2180362',
  patched: '5d194162b17c9df45b626be0192b9b66a45d5b3f4efa9b54d611edde9d11095d',
  scopes: 11,
});
const digest = source => crypto.createHash('sha256').update(source).digest('hex');
const includesUndefined = node => node.kind === ts.SyntaxKind.UndefinedKeyword ||
  (ts.isUnionTypeNode(node) && node.types.some(part => part.kind === ts.SyntaxKind.UndefinedKeyword));

function repairOptionalIndexSignatures(source) {
  const tree = ts.createSourceFile('chakra-theme.d.ts', source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error('Invalid Chakra declaration syntax');
  const insertions = [];
  function visit(node) {
    if (ts.isTypeLiteralNode(node) && node.members.some(member =>
      ts.isPropertySignature(member) && member.questionToken && member.type && includesUndefined(member.type))) {
      for (const member of node.members) {
        if (ts.isIndexSignatureDeclaration(member) && member.type && !includesUndefined(member.type)) {
          insertions.push(member.type.end);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  let patched = source;
  for (const offset of insertions.sort((a, b) => b - a)) {
    patched = patched.slice(0, offset) + ' | undefined' + patched.slice(offset);
  }
  return { source: patched, scopes: insertions.length };
}

function patchReviewedDeclaration(source, version) {
  if (version !== SUPPORTED.version) throw new Error('Unreviewed Chakra theme version');
  const hash = digest(source);
  if (hash === SUPPORTED.patched) return { source, scopes: 0 };
  if (hash !== SUPPORTED.original) throw new Error('Unreviewed Chakra theme declaration content');
  const result = repairOptionalIndexSignatures(source);
  if (result.scopes !== SUPPORTED.scopes || digest(result.source) !== SUPPORTED.patched) {
    throw new Error('Chakra theme declaration repair did not match reviewed scope/hash');
  }
  return result;
}

function main() {
  const entry = require.resolve('@chakra-ui/theme');
  if (!entry.endsWith(path.join('dist', 'cjs', 'index.cjs'))) throw new Error('Unreviewed Chakra package layout');
  const packageDir = path.resolve(path.dirname(entry), '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (pkg.name !== '@chakra-ui/theme') throw new Error('Unexpected Chakra package');
  const declaration = path.join(packageDir, 'dist/types/index.d.ts');
  const original = fs.readFileSync(declaration, 'utf8');
  const result = patchReviewedDeclaration(original, pkg.version);
  if (result.scopes) fs.writeFileSync(declaration, result.source);
  console.log(`Chakra theme type repair: ${result.scopes} reviewed declaration scopes (runtime unchanged)`);
}

if (require.main === module) main();
module.exports = { SUPPORTED, digest, repairOptionalIndexSignatures, patchReviewedDeclaration };
