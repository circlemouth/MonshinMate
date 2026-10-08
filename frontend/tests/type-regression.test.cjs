// Offline regressions for the API-boundary fixes uncovered by strict type checking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src', relative), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(module,exports){${code}\n})`)(module, module.exports);
  return module.exports;
}

const { parseQuestionnaireList, parseUploadedImageUrl, replaceUploadedImage } = load('utils/questionnaireAdmin.ts');

test('build gates keep strict whole-program checking before Vite bundling', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../tsconfig.json'), 'utf8'));
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.moduleResolution, 'Bundler');
  assert.equal(config.compilerOptions.esModuleInterop, true);
  assert.notEqual(config.compilerOptions.skipLibCheck, true);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.match(pkg.scripts.typecheck, /^tsc --noEmit$/);
  assert.match(pkg.scripts.build, /^npm run typecheck\s*&&\s*vite build$/);
  assert.equal(pkg.scripts.postinstall, 'node scripts/patch-chakra-theme-types.cjs');
  const docker = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
  const patchCopy = docker.indexOf('COPY frontend/scripts/patch-chakra-theme-types.cjs ./scripts/patch-chakra-theme-types.cjs');
  const install = docker.indexOf('RUN npm ci');
  assert.ok(patchCopy >= 0 && install > patchCopy, 'Docker copies the postinstall declaration repair before npm ci');
});

test('strict compiler still rejects malformed patient credentials, admin tokens, generation and personal info', () => {
  const project = path.resolve(__dirname, '..');
  const configFile = ts.readConfigFile(path.join(project, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, project);
  assert.equal(config.options.strict, true);
  assert.notEqual(config.options.skipLibCheck, true);
  const filename = path.join(project, 'src/__type-regression-fixture.ts');
  const imports = `
    import { storePatientSession, isPatientGeneration } from './utils/patientSession';
    import { acceptAdminToken } from './utils/adminApi';
    import type { PersonalInfoValue } from './utils/personalInfo';
  `;
  function diagnostics(body) {
    const options = { ...config.options, noEmit: true };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, createNew) => file === filename
      ? ts.createSourceFile(filename, imports + body, language, true)
      : original(file, language, onError, createNew);
    const program = ts.createProgram([filename], options, host);
    return ts.getPreEmitDiagnostics(program).filter(item => item.file?.fileName === filename);
  }
  assert.equal(diagnostics(`
    storePatientSession({ id: 'synthetic', session_token: 'synthetic-token', expires_at: '2099-01-01' });
    acceptAdminToken({ access_token: 'synthetic-admin-token' });
    isPatientGeneration(1);
    const info: PersonalInfoValue = { name: '', kana: '', postal_code: '', address: '', phone: '' };
  `).length, 0);
  const rejected = diagnostics(`
    storePatientSession({ id: 'synthetic', expires_at: '2099-01-01' });
    storePatientSession({ id: 'synthetic', session_token: 42, expires_at: '2099-01-01' });
    acceptAdminToken({ access_token: 42 });
    isPatientGeneration('1');
    const info: PersonalInfoValue = { name: 'synthetic' };
  `);
  assert.equal(rejected.length, 5, rejected.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
});

test('template IDs remain strings, deduplicate in order and retain default selection candidates', () => {
  const result = parseQuestionnaireList([{ id: 'default' }, { id: 'synthetic' }, { id: 'default' }]);
  assert.deepEqual(Array.from(result, ({ id }) => id), ['default', 'synthetic']);
  assert.equal(parseQuestionnaireList([]).length, 0);
});

test('malformed API template IDs fail closed rather than enter selection state', () => {
  for (const value of [null, {}, [{ id: 42 }], [{ id: {} }], [{}], [null], [{ id: '' }], [{ id: '  ' }]]) {
    assert.throws(() => parseQuestionnaireList(value), /Invalid questionnaire/);
  }
});

test('image upload results share the editor null failure contract and reject malformed URLs', () => {
  assert.equal(parseUploadedImageUrl({ url: '/questionnaire-item-images/synthetic.png' }),
    '/questionnaire-item-images/synthetic.png');
  for (const value of [null, {}, { url: null }, { url: 42 }, { url: {} }, { url: '' }, { url: ' ' }]) {
    assert.equal(parseUploadedImageUrl(value), null);
  }
});

test('image replacement uploads successfully before deleting the prior image or committing the new URL', async () => {
  const events = [];
  const url = await replaceUploadedImage({}, '/old.png',
    async () => { events.push('upload'); return '/new.png'; },
    async old => { events.push(`delete:${old}`); });
  if (url) events.push(`commit:${url}`);
  assert.deepEqual(events, ['upload', 'delete:/old.png', 'commit:/new.png']);
});

test('failed or malformed replacement preserves the old image and state', async () => {
  for (const response of [null, {}, { url: 42 }]) {
    let deleted = false;
    let state = '/old.png';
    const url = await replaceUploadedImage({}, state,
      async () => parseUploadedImageUrl(response), async () => { deleted = true; });
    if (url) state = url;
    assert.equal(deleted, false);
    assert.equal(state, '/old.png');
  }
  let deleted = false;
  await assert.rejects(replaceUploadedImage({}, '/old.png', async () => { throw new Error('synthetic failure'); },
    async () => { deleted = true; }), /synthetic failure/);
  assert.equal(deleted, false);
  const source = fs.readFileSync(path.resolve(__dirname, '../src/pages/AdminTemplates.tsx'), 'utf8');
  assert.equal((source.match(/await replaceUploadedImage\(file, (?:fi|item|newItem)\.image, uploadItemImage, deleteItemImage\)/g) || []).length, 3);
  assert.match(source, /notify\(\{ title: '画像をアップロードできませんでした', status: 'error' \}\)/);
});

test('personal information keys and keyboard modes stay explicit without weakening values', () => {
  const { personalInfoFields, createPersonalInfoValue, personalInfoMissingKeys } = load('utils/personalInfo.ts');
  assert.deepEqual(Array.from(personalInfoFields, ({ key }) => key), ['name', 'kana', 'postal_code', 'address', 'phone']);
  assert.deepEqual(Array.from(personalInfoFields, ({ inputMode }) => inputMode), ['text', 'text', 'numeric', 'text', 'tel']);
  assert.equal(personalInfoMissingKeys(createPersonalInfoValue()).length, 5);
  const synthetic = createPersonalInfoValue({ name: 'synthetic', kana: 'synthetic', postal_code: '000-0000', address: 'synthetic', phone: '000' });
  assert.equal(personalInfoMissingKeys(synthetic).length, 0);
});
