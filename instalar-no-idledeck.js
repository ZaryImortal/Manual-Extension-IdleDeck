// Script para instalar ou atualizar suas extensões no IdleDeck (Microsoft Store) by Zary
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1. Função para calcular o ID da extensão derivado da chave pública (padrão Chromium)
function idFromKey(pubKeyDer) {
  return [...crypto.createHash('sha256').update(pubKeyDer).digest('hex').slice(0, 32)]
    .map(o => String.fromCharCode(97 + parseInt(o, 16))).join('');
}

// 2. Função de hash da árvore de arquivos (padrão de integridade do IdleDeck)
function treeHash(tree) {
  const t = crypto.createHash('sha256');
  for (const [o, r] of [...tree].sort((i, n) => (i[0] < n[0] ? -1 : 1))) {
    t.update(o).update('\0').update(crypto.createHash('sha256').update(r).digest('hex')).update('\n');
  }
  return t.digest('hex');
}

// 3. Shim de compatibilidade exigido pelo IdleDeck para Electron
const SHIM_VERSION = 4;
const SHIM_FILE = 'idledeck-compat.js';
const BG_WRAPPER = 'idledeck-background.js';
const ACTION_PAGE = 'idledeck-action.html';
const ACTION_SCRIPT = 'idledeck-action.js';

const SHIM_SOURCE = `/* IdleDeck: APIs do Chrome que o navegador das contas não tem */
(() => {
  const c = globalThis.chrome;
  if (!c) return;
  const ev = () => {
    const l = new Set();
    return { addListener: (f) => l.add(f), removeListener: (f) => l.delete(f), hasListener: (f) => l.has(f), hasListeners: () => l.size > 0, list: () => [...l] };
  };
  const reply = (value, args) => {
    const cb = [...args].reverse().find((a) => typeof a === 'function');
    if (cb) setTimeout(() => cb(value), 0);
    return Promise.resolve(value);
  };
  const def = (name, api) => {
    if (c[name]) return;
    try { Object.defineProperty(c, name, { value: api, configurable: true, enumerable: true }); } catch {}
  };
  def('sidePanel', {
    open: (...args) => reply(undefined, args),
    close: (...args) => reply(undefined, args),
    setOptions: (opts, ...rest) => reply(undefined, [opts, ...rest]),
    getOptions: (...args) => reply({ path: '', enabled: true }, args),
    setPanelBehavior: (...args) => reply(undefined, args),
    getPanelBehavior: (...args) => reply({ openPanelOnActionClick: false }, args),
    onOpened: ev(),
    onClosed: ev()
  });
})();
`;

const ACTION_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/${SHIM_FILE}"><\/script><script src="/${ACTION_SCRIPT}"><\/script></head><body></body></html>`;
const ACTION_SOURCE = `/* IdleDeck action fallback */`;

function applyShim(tree) {
  const result = new Map(tree);
  let manifest;
  try {
    manifest = JSON.parse(result.get('manifest.json').toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return result;
  }

  result.set(SHIM_FILE, Buffer.from(SHIM_SOURCE));
  const bg = manifest.background || {};
  if (bg.service_worker || Array.isArray(bg.scripts) || bg.page) {
    result.set(ACTION_PAGE, Buffer.from(ACTION_HTML));
    result.set(ACTION_SCRIPT, Buffer.from(ACTION_SOURCE));
  }

  if (typeof bg.service_worker === 'string' && bg.service_worker) {
    const orig = bg.service_worker.replace(/^\//, '');
    const code = bg.type === 'module'
      ? `import './${SHIM_FILE}';\nimport './${orig}';\n`
      : `importScripts('/${SHIM_FILE}', '/${orig}');\n`;
    result.set(BG_WRAPPER, Buffer.from(`/* IdleDeck wrapper */\n${code}`));
    manifest.background = { ...bg, service_worker: BG_WRAPPER };
  }

  result.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  return result;
}

function readTree(dir) {
  const map = new Map();
  function walk(subdir) {
    for (const ent of fs.readdirSync(path.join(dir, subdir), { withFileTypes: true })) {
      const rel = subdir ? `${subdir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(rel);
      } else if (ent.isFile()) {
        map.set(rel, fs.readFileSync(path.join(dir, rel)));
      }
    }
  }
  walk('');
  return map;
}

// ---- Execução Principal ----
const srcDir = __dirname;
const keyFile = path.join(srcDir, '.extension-key.json');

let keyData;
if (fs.existsSync(keyFile)) {
  keyData = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
} else {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  keyData = {
    id: idFromKey(publicKey),
    publicKey: publicKey.toString('base64'),
    privateKey
  };
  fs.writeFileSync(keyFile, JSON.stringify(keyData, null, 2));
}

const extId = keyData.id;
const manifestRaw = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
const version = manifestRaw.version || '1.15.1';

// Localizar IdleDeck
const packagesDir = path.join(process.env.LOCALAPPDATA, 'Packages');
const idleDeckPkg = fs.readdirSync(packagesDir).find(p => p.startsWith('MacedoTI.IdleDeck'));
if (!idleDeckPkg) {
  console.error('Erro: Pasta do IdleDeck não encontrada em LocalAppData\\Packages.');
  process.exit(1);
}

const idleDeckRoaming = path.join(packagesDir, idleDeckPkg, 'LocalCache', 'Roaming', 'IdleDeck');
const extTargetDir = path.join(idleDeckRoaming, 'extensions', extId, version);
const extMetaPath = path.join(idleDeckRoaming, 'extensions', extId, `${version}.json`);
const cfgPath = path.join(idleDeckRoaming, 'config.json');

console.log(`[Extensão -> IdleDeck]`);
console.log(`ID da Extensão: ${extId}`);
console.log(`Versão: ${version}`);
console.log(`Destino: ${extTargetDir}`);

// Carregar arquivos fonte
const sourceTree = readTree(srcDir);
sourceTree.delete('.extension-key.json');
sourceTree.delete('instalar-no-idledeck.js');
sourceTree.delete('instalar-no-idledeck.bat');

// Garantir resolução do worker copiando src/lib para lib/
for (const [k, v] of [...sourceTree.entries()]) {
  if (k.startsWith('src/lib/')) {
    sourceTree.set(k.replace(/^src\//, ''), v);
  }
}

// Injetar chave no manifest
manifestRaw.key = keyData.publicKey;
sourceTree.set('manifest.json', Buffer.from(JSON.stringify(manifestRaw, null, 2)));

// Aplicar Shim
const shimmedTree = applyShim(sourceTree);

// Escrever no diretório de extensões do IdleDeck
fs.mkdirSync(extTargetDir, { recursive: true });
for (const [relPath, content] of shimmedTree) {
  const full = path.join(extTargetDir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Calcular hash dos arquivos instalados
const installedTree = readTree(extTargetDir);
const hash = treeHash(installedTree);

// Criar metadados da extensão para a biblioteca do IdleDeck
const meta = {
  kind: 'extension',
  ref: `cws:${extId}`,
  name: manifestRaw.name || 'Extensão by Zary',
  description: manifestRaw.description || '',
  level: 'high',
  auto: true,
  crxSha256: '',
  publicKey: keyData.publicKey,
  from: 'clients2.google.com',
  shim: SHIM_VERSION,
  compat: 'ok',
  id: extId,
  version,
  treeHash: hash,
  downloadedAt: Date.now()
};

fs.writeFileSync(extMetaPath, JSON.stringify(meta, null, 2));

// Atualizar o config.json do IdleDeck para todas as contas de PokeIdle by Zary
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  const pokeSlots = (cfg.slots || []).filter(
    s => typeof s.url === 'string' && s.url.includes('pokeidle')
  );

  if (pokeSlots.length > 0) {
    for (const slot of pokeSlots) {
      slot.extensions = slot.extensions || [];
      slot.extensions = slot.extensions.filter(e => e.id !== extId);
      slot.extensions.push({
        id: extId,
        version,
        enabled: true,
        addedAt: Date.now(),
        level: 'high'
      });
      console.log(`Slot "${slot.name}" configurado com sucesso no IdleDeck!`);
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
}

console.log('✅ Extensão instalada e vinculada com sucesso nas suas contas do IdleDeck!');
