import * as fs from 'node:fs'
import depcheck from 'depcheck';
import { execSync as exec } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';

const __dirname = dirname(fileURLToPath(import.meta.url))

export default function ({
    builddir = 'build',
    ext_modules = [],
    params = null,
    plugin = null,
    minify = true
} = {}) {
    return {
        name: '@natterbox/aws-sveltekit-adapter',
        async adapt(builder) {

            const workdir = resolve('./.svelte-kit/aws-sveltekit-adapter')
            const outputdir = resolve(builddir)

            const cwd = process.cwd()

            // delete everything first

            builder.rimraf(outputdir)
            builder.rimraf(workdir)

            // create a directory for the server output, to be imported
            // into the SSR lambda

            fs.mkdirSync(outputdir)
            fs.mkdirSync(outputdir + '/lambda')

            // copy the files built by svelte-kit to the ./build/server and ./build/static directories

            builder.writeServer(workdir)
            builder.writeClient(outputdir + '/static')
            builder.writePrerendered(outputdir + '/static')

            // copy the source of the lambda handler from the module directory

            fs.copyFileSync(__dirname + '/handler/handler.js', workdir + '/handler.js')

            // cd to the working directory

            process.chdir(workdir)

            // write am empty package.json to lambda dir so that 'npm import' works

            fs.writeFileSync('package.json', '{}')

            // insert crypto require - aws does not support built in crypto
            // this took a while to figure out ... :/
            let logRows = fs.readFileSync(`${workdir}/index.js`).toString().split('\n')
            logRows.unshift('import {webcrypto as crypto} from "crypto"')
            fs.writeFileSync(`${workdir}/index.js`, logRows.join('\n'))

            // use depcheck to get the names of any missing modules

            const depcheck_options = {
                ignoreBinPackage: false, // ignore the packages with bin entry
                skipMissing: false, // skip calculation of missing dependencies
                parsers: {
                    // the target parsers
                    '**/*.js': depcheck.parser.es6,
                },
                detectors: [
                    // the target detectors
                    depcheck.detector.requireCallExpression,
                    depcheck.detector.importDeclaration,
                ],
                specials: [
                    // the target special parsers
                    depcheck.special.eslint,
                    depcheck.special.webpack,
                ],
                package: {
                    // may specify dependencies instead of parsing package.json
                    dependencies: {},
                    devDependencies: {},
                    peerDependencies: {},
                    optionalDependencies: {},
                },
            }

            const result = await depcheck('./', depcheck_options)
            let missing_pkgs = Object.keys(result.missing)

            // handle plugin install
            let pluginInfo = {}
            let dynamicRequireTargets = []
            if (plugin) {
                if ("source" in plugin) {
                    // if we're given a module source directory, pack it and use the result
                    const response = exec(`cd "${plugin.source}" && npm --json --pack-destination "${workdir}" pack`)
                    let jsonResponse = JSON.parse(response)
                    // add to the list of modules we will get rpm to load
                    missing_pkgs.push(`./${jsonResponse[0].filename}`)
                    // info for the params file relating to the plugin
                    pluginInfo.requirePackageName = jsonResponse[0].name
                    pluginInfo.initData = plugin.initData ?? null
                    // tell rollup how to deal with the plugin as a dynamic import
                    dynamicRequireTargets.push(`node_modules/${jsonResponse[0].name}`)
                } else if ("package" in plugin) {
                    // add to the list of modules we will get rpm to load
                    missing_pkgs.push(plugin.package)
                    // info for the params file relating to the plugin
                    pluginInfo.requirePackageName = plugin.package
                    pluginInfo.initData = plugin.initData ?? null
                    // tell rollup how to deal with the plugin as a dynamic import
                    dynamicRequireTargets.push(`node_modules/${plugin.package}`)
                }
            }

            // add cross-fetch if not already there as the fetch polyfill is
            // instanced in the handler function so that everyone has access
            // to fetch() - svelte kit assumes fetch is available
            // also, check the ext_modules config. This is intended to scoop
            // up any modules that have been externalized during the sveltekit
            // build.

            // a getRandomValues polyfill is also needed for nodejs on lambda
            // which uses mersenne-twister (see handler.js)

            for (const pkg of ['cross-fetch', 'mersenne-twister', ...ext_modules]) {
                if (!missing_pkgs.includes(pkg)) {
                    missing_pkgs.push(pkg)
                }
            }

            // Install the packages. There is no way I can find to install the package
            // programatically so invoke npm via the shell

            const pkgs = missing_pkgs.join(' ')
            console.log('installing packages ' + pkgs)
            let child = exec(`npm install --no-audit --no-fund --save ${pkgs}`)
            console.log(child.toString())

            // write any params to params.js. empty ob if not there

            fs.writeFileSync('params.json', JSON.stringify(Object.assign(params ?? {}, { plugin: pluginInfo })))

            const bundle = await rollup({
                input: `./handler.js`,
                external: [
                    // dependencies could have deep exports, so we need a regex
                    ...Object.keys(missing_pkgs || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`))
                ],
                plugins: [nodeResolve({ preferBuiltins: true }), commonjs({ dynamicRequireTargets }), json()].concat(minify ? [terser()] : []),
            });

            await bundle.write({
                dir: `${outputdir}/lambda`,
                format: 'cjs',
                sourcemap: true,
                chunkFileNames: `chunks/[name]-[hash].js`
            });

            // done

            process.chdir(cwd)
        }
    }
}
