/**
 * Build a static snapshot of the external resources so the GUI can load
 * devices / extensions indexes and all extension files from a plain static
 * file server (or the webpack dev server) instead of the local
 * openblock-resource service.
 *
 * Output layout (mirrors the URLs the resource server exposes):
 *   <out>/devices/<locale>.json
 *   <out>/extensions/<locale>.json
 *   <out>/extensions/<extensionId dir>/... (blocks.js, toolbox.js, assets ...)
 *
 * Differences from the live server:
 *   - Indexes are pre-generated for every locale found in the resources.
 *   - Each extension entry gains a `libraryFiles` array: the .py files of
 *     its lib directory as relative URLs, so browser-direct uploaders
 *     (Web Bluetooth / Web Serial) can fetch and install them on the board.
 *   - The `library` field (used by OpenBlock Link, must be an absolute
 *     path on the machine running Link) is prefixed with --library-prefix.
 *
 * Usage:
 *   node script/build-static.js \
 *     --resources ../external-resources-v3 \
 *     --out ../openblock-gui/external-resources-static/external-resources \
 *     --library-prefix /resources/
 */

const fs = require('fs');
const path = require('path');
const formatMessage = require('format-message');
const requireAll = require('require-all');

const parseArgs = () => {
    const args = {
        resources: null,
        out: null,
        libraryPrefix: null
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--resources') {
            args.resources = argv[++i];
        } else if (argv[i] === '--out') {
            args.out = argv[++i];
        } else if (argv[i] === '--library-prefix') {
            args.libraryPrefix = argv[++i];
        }
    }
    if (!args.resources || !args.out) {
        console.error('Usage: node build-static.js --resources <path> --out <path> [--library-prefix <prefix>]');
        process.exit(1);
    }
    args.resources = path.resolve(args.resources);
    args.out = path.resolve(args.out);
    return args;
};

// Locales that are always generated even when no resource provides
// translations for them (formatMessage falls back to the default text).
const BASE_LOCALES = ['en', 'zh-cn', 'zh-tw', 'ru'];

/**
 * Flatten the nested object produced by require-all into a list of
 * [relativeDirPath, moduleExports] pairs for every directory that holds
 * an index.js.
 * @param {object} node - the (nested) require-all result.
 * @param {Array.<string>} prefix - accumulated directory names.
 * @param {Array} result - output accumulator.
 * @return {Array} list of [relativeDirPath, indexFactory] pairs.
 */
const collectIndexModules = (node, prefix = [], result = []) => {
    Object.entries(node).forEach(([name, value]) => {
        if (name === 'index.js' && typeof value === 'function') {
            result.push([prefix.join('/'), value]);
        } else if (value && typeof value === 'object') {
            collectIndexModules(value, prefix.concat(name), result);
        }
    });
    return result;
};

/**
 * List the .py files of a lib directory (recursively) as forward-slash
 * relative paths.
 * @param {string} libPath - absolute path of the lib directory.
 * @param {string} baseUrl - url prefix for the returned entries.
 * @return {Array.<string>} relative urls of the .py files.
 */
const listLibraryFiles = (libPath, baseUrl) => {
    const files = [];
    if (!fs.existsSync(libPath) || !fs.statSync(libPath).isDirectory()) {
        return files;
    }
    fs.readdirSync(libPath).forEach(entry => {
        const full = path.join(libPath, entry);
        if (fs.statSync(full).isFile() && entry.endsWith('.py')) {
            files.push(`${baseUrl}/${entry}`);
        }
    });
    return files;
};

/**
 * Copy an extension directory into the output, keeping everything the
 * browser needs and skipping non-python library sources (Arduino C/C++
 * libraries are only used by Link through the local filesystem).
 * @param {string} src - absolute source directory.
 * @param {string} dest - absolute destination directory.
 * @param {boolean} insideLib - whether the current directory is a lib dir.
 */
const copyExtensionDir = (src, dest, insideLib = false) => {
    fs.mkdirSync(dest, {recursive: true});
    fs.readdirSync(src).forEach(entry => {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            copyExtensionDir(srcPath, destPath, insideLib || entry === 'lib');
        } else if (!insideLib || entry.endsWith('.py')) {
            fs.copyFileSync(srcPath, destPath);
        }
    });
};

/**
 * Gather the set of locales provided by translations.js files.
 * @param {Array} indexModules - list of [relativeDir, factory] pairs.
 * @param {string} typePath - absolute path of the extensions/devices dir.
 * @return {Array.<string>} sorted locale codes.
 */
const collectLocales = (indexModules, typePath) => {
    const locales = new Set(BASE_LOCALES);
    indexModules.forEach(([relDir]) => {
        const translationsFile = path.join(typePath, relDir, 'translations.js');
        if (fs.existsSync(translationsFile)) {
            // eslint-disable-next-line global-require
            const translations = require(translationsFile).getInterfaceTranslations();
            Object.keys(translations).forEach(locale => locales.add(locale));
        }
    });
    return Array.from(locales).sort();
};

/**
 * Build the index entries of one resource type for one locale.
 * @param {string} type - 'extensions' or 'devices'.
 * @param {string} resourcesPath - absolute path of the resources repo.
 * @param {string} locale - the locale to generate.
 * @param {string} libraryPrefix - prefix for Link-side absolute paths.
 * @return {Array.<object>} the index entries.
 */
const assembleIndex = (type, resourcesPath, locale, libraryPrefix) => {
    const typePath = path.join(resourcesPath, type);
    if (!fs.existsSync(typePath)) {
        return [];
    }

    const fm = formatMessage.namespace();
    fm.setup({locale: locale});

    const data = requireAll({dirname: typePath, filter: /^index\.js$/, recursive: true});
    const indexModules = collectIndexModules(data);
    const entries = [];

    indexModules.forEach(([relDir, factory]) => {
        if (relDir === '') {
            // A top level index.js is the device ordering list, not a resource.
            return;
        }
        const translationsFile = path.join(typePath, relDir, 'translations.js');
        if (fs.existsSync(translationsFile)) {
            // eslint-disable-next-line global-require
            const translations = require(translationsFile).getInterfaceTranslations();
            fm.setup({translations: translations});
        }

        const baseUrl = `${type}/${relDir}`;
        const processEntry = content => {
            ['iconURL', 'connectionIconURL', 'connectionSmallIconURL', 'blocks',
                'generator', 'toolbox', 'main', 'translations', 'msg'].forEach(key => {
                if (content[key]) {
                    content[key] = `${baseUrl}/${content[key]}`;
                }
            });
            if (content.library) {
                const relLibrary = `${baseUrl}/${content.library}`;
                content.libraryFiles = listLibraryFiles(
                    path.join(typePath, relDir, 'lib'), `${baseUrl}/lib`);
                content.library = libraryPrefix ?
                    `${libraryPrefix}${relLibrary}` :
                    path.join(resourcesPath, relLibrary);
            }
            ['firmware', 'arduinoData'].forEach(key => {
                if (content[key]) {
                    const rel = `${baseUrl}/${content[key]}`;
                    content[key] = libraryPrefix ? `${libraryPrefix}${rel}` : path.join(resourcesPath, rel);
                }
            });
            entries.push(content);
        };

        const content = factory(fm);
        if (Array.isArray(content)) {
            content.forEach(processEntry);
        } else {
            processEntry(content);
        }
    });

    return entries;
};

const main = () => {
    const {resources, out, libraryPrefix} = parseArgs();

    fs.rmSync(out, {recursive: true, force: true});
    fs.mkdirSync(out, {recursive: true});

    ['devices', 'extensions'].forEach(type => {
        const typePath = path.join(resources, type);
        const outTypePath = path.join(out, type);
        fs.mkdirSync(outTypePath, {recursive: true});

        let locales = BASE_LOCALES;
        let dirs = [];
        if (fs.existsSync(typePath)) {
            const data = requireAll({dirname: typePath, filter: /^index\.js$/, recursive: true});
            const indexModules = collectIndexModules(data);
            locales = collectLocales(indexModules, typePath);
            dirs = indexModules.map(([relDir]) => relDir).filter(relDir => relDir !== '');
        }

        locales.forEach(locale => {
            const index = assembleIndex(type, resources, locale, libraryPrefix);
            fs.writeFileSync(
                path.join(outTypePath, `${locale}.json`),
                JSON.stringify(index, null, 0)
            );
        });

        dirs.forEach(relDir => {
            copyExtensionDir(path.join(typePath, relDir), path.join(outTypePath, relDir));
        });

        console.log(`${type}: ${dirs.length} resources, locales: ${locales.join(', ')}`);
    });

    console.log(`Static resources written to ${out}`);
};

main();
