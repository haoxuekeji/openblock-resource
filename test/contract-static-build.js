/**
 * OB-031C: 外部资源静态快照契约测试。
 *
 * 从本地 external-resources-v3 构建静态快照到临时目录，然后校验：
 *   1. devices / extensions 各 locale 索引可解析且非空；
 *   2. 索引条目引用的相对路径文件（icon/blocks/generator/toolbox/translations/
 *      runtime/libraryFiles）全部存在；
 *   3. 发布关键扩展（espDht / espRgbLedStrip / espTm1650）在索引中存在。
 *
 * 用法：node test/contract-static-build.js [--resources <path>]
 * 资源目录默认 ../external-resources-v3（多仓工作区布局）。
 * 退出码 0 = 契约满足；非 0 = 失败并打印明细。
 */

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const resIdx = argv.indexOf('--resources');
const RESOURCES = path.resolve(
    resIdx >= 0 ? argv[resIdx + 1] : path.join(__dirname, '..', '..', 'external-resources-v3')
);

const REQUIRED_EXTENSIONS = ['espDht', 'espRgbLedStrip', 'espTm1650'];
const CHECK_LOCALES = ['en', 'zh-cn'];

let failures = 0;
const fail = msg => {
    failures++;
    process.stderr.write(`  FAIL: ${msg}\n`);
};
const info = msg => process.stdout.write(`${msg}\n`);

if (!fs.existsSync(path.join(RESOURCES, 'extensions'))) {
    process.stderr.write(`资源目录不存在或不完整: ${RESOURCES}\n`);
    process.stderr.write('请检出 external-resources-v3 或用 --resources 指定路径\n');
    process.exit(2);
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-resource-contract-'));

info(`building static snapshot: ${RESOURCES} -> ${OUT}`);
execFileSync(process.execPath, [
    path.join(__dirname, '..', 'script', 'build-static.js'),
    '--resources', RESOURCES,
    '--out', OUT,
    '--library-prefix', '/resources/'
], {stdio: ['ignore', 'ignore', 'inherit']});

/**
 * 收集条目中引用的相对路径（相对快照根目录）。
 * @param {object} entry - 索引条目
 * @returns {Array.<string>} 相对路径列表
 */
const relativeRefs = entry => {
    const refs = [];
    for (const key of ['iconURL', 'blocks', 'generator', 'toolbox', 'translations', 'runtime',
        'connectionIconURL', 'connectionSmallIconURL', 'firmware']) {
        const v = entry[key];
        if (typeof v === 'string' && v.length > 0 && !v.startsWith('/') && !/^https?:/.test(v)) {
            refs.push(v);
        }
    }
    if (Array.isArray(entry.libraryFiles)) {
        for (const f of entry.libraryFiles) {
            if (typeof f === 'string' && !f.startsWith('/') && !/^https?:/.test(f)) refs.push(f);
        }
    }
    return refs;
};

const checkIndex = (kind, locale, allowEmpty) => {
    const idxPath = path.join(OUT, kind, `${locale}.json`);
    if (!fs.existsSync(idxPath)) {
        fail(`${kind}/${locale}.json 不存在`);
        return [];
    }
    let entries;
    try {
        entries = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } catch (e) {
        fail(`${kind}/${locale}.json 解析失败: ${e.message}`);
        return [];
    }
    if (!Array.isArray(entries)) {
        fail(`${kind}/${locale}.json 不是数组`);
        return [];
    }
    if (entries.length === 0) {
        // 设备均内置于 GUI/VM，外部资源 devices 索引为空是既定状态
        if (!allowEmpty) fail(`${kind}/${locale}.json 为空`);
        return entries;
    }
    let missing = 0;
    for (const entry of entries) {
        for (const ref of relativeRefs(entry)) {
            if (!fs.existsSync(path.join(OUT, ref))) {
                missing++;
                fail(`${kind}/${locale} 条目 ${entry.extensionId || entry.deviceId || entry.name} 引用缺失文件: ${ref}`);
            }
        }
    }
    info(`  ${kind}/${locale}.json: ${entries.length} 个条目, 缺失引用 ${missing}`);
    return entries;
};

for (const locale of CHECK_LOCALES) {
    checkIndex('devices', locale, true);
}

let extensionIds = new Set();
for (const locale of CHECK_LOCALES) {
    const entries = checkIndex('extensions', locale, false);
    if (locale === 'en') {
        extensionIds = new Set(entries.map(e => e.extensionId));
    }
}

for (const id of REQUIRED_EXTENSIONS) {
    if (!extensionIds.has(id)) {
        fail(`发布关键扩展缺失: ${id}`);
    }
}

fs.rmSync(OUT, {recursive: true, force: true});

if (failures > 0) {
    process.stderr.write(`\ncontract-static-build: ${failures} 个失败\n`);
    process.exit(1);
}
info('contract-static-build: OK');
