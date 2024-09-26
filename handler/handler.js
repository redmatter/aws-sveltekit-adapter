// polyfills
require('cross-fetch/polyfill')
const MersenneTwister = require('mersenne-twister')

const indexPkg = require('./index')
const manifestPkg = require('./manifest')
const params = require('./params')

let plugin = null
if (params.plugin.requirePackageName) {
    try {
        let pluginClass = require(params.plugin.requirePackageName)
        if (params.plugin.initData) {
            plugin = new pluginClass(params.plugin.initData)
        } else {
            plugin = new pluginClass()
        }
    } catch (e) {
        console.log("error loading plugin", e)
        throw e
    }
}

const { Server } = indexPkg
const { manifest, prerendered } = manifestPkg
const server = new Server(manifest)
const app_path = `/${manifest.appPath}`
const manifest_assets = manifest.assets ?? new Set
const manifest_prerendered = prerendered ?? new Set
const asset_path = manifest.appPath.replace(manifest.appDir, "")
const manifest_assets_path = asset_path != '' ? new Set([...(Array.from(manifest_assets).map(item => asset_path + item))]) : manifest_assets
let initialised = false

// crypto.getRandomNumbers polyfill
// see https://github.com/kumavis/polyfill-crypto.getrandomvalues
const twister = new MersenneTwister(Math.random() * Number.MAX_SAFE_INTEGER)
if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    global.crypto = {
        ...global.crypto,
        getRandomValues: (abv) => {
            var l = abv.length
            while (l--) {
                abv[l] = Math.floor(twister.random() * 256)
            }
            return abv
        }
    }
}

function init() {
    if (!initialised) {
        initialised = true
        return server.init({ env: {} })
    } else {
        return Promise.resolve()
    }
}

function isStatic(path) {
    return path.match(new RegExp(`^${app_path.replace("/", "\\/")}(\\/|$)`))
}

function isInManifest(file) {
    if ((manifest_assets_path.has(file) || manifest_assets_path.has(file + '/index.html')) ||
        (manifest_prerendered.has(file || '/'))) {
        return true
    }

    return false
}

// normal (regional) lambda handler behind an API gateway
async function apigw_handler(event) {

    await init()

    const { headers } = event
    const pathname = event.rawPath.replace(/^\/|\/$/, '')
    const querystring = event.rawQueryString ? "?" + event.rawQueryString : ""

    // static assets
    if (isStatic(pathname)) {
        console.log("handler event received request for static file ... error?", pathname)
    }

    // prerendered pages and index.html files
    if (isInManifest(pathname)) {
        console.log("handler event received request for manifest file ... error?", pathname)
    }

    const stdRequest = new Request(`https://${event.requestContext.domainName}${event.rawPath}${querystring}`, {
        method: event.requestContext.httpMethod,
        headers: Object.values(headers).reduce((acc, item) => {
            item.value.split(',').forEach((hval) => acc.append(item.key, hval))
            return acc
        }, new Headers())
    })

    if (!['HEAD', 'GET'].includes(stdRequest.method)) {
        stdRequest.body = event.body
    }

    console.log("handler event - standard request", stdRequest)

    const response = await server.respond(stdRequest, {
        platform: {},
        getClientAddress: () => event.requestContext.http.sourceIp,
        manifest
    })

    let resp
    if (response) {
        resp = {
            headers: {},
            multiValueHeaders: {},
            body: await response.text(),
            statusCode: response.status
        }
        Object.keys(response.headers).forEach(k => {
            const v = response.headers[k]
            if (v instanceof Array) {
                resp.multiValueHeaders[k] = v
            } else {
                resp.headers[k] = v
            }
        })
        return resp
    } else {
        resp = {
            statusCode: 404,
            body: 'Not found.'
        }
    }

    console.log("response", resp)
    return resp
}

// lambda@edge handler installed as cloudfront origin request handler
async function cf_origin_request_handler(event) {

    await init()

    let request = Object.assign(event.Records[0].cf.request)
    const querystring = request.querystring ? "?" + request.querystring : ""

    if ('x-cachepathprefix' in request.headers) {
        const pathPrefix = request.headers["x-cachepathprefix"][0].value
        const parts = request.uri.split(/(?<!^)\//)
        if (parts[0] == pathPrefix) {
            console.log(`removing path prefix ${parts[0]}`)
            request.uri = "/" + parts.slice(1).join("/")
        } else {
            console.log(`X-CachePathPrefix set: ${pathPrefix}, got ${parts[0]}`)
        }
    }

    // plugin code can be inserted here, eg auth
    if (plugin && plugin.handle) {
        const r = await plugin.handle(request)
        if ("status" in r) {
            // it's a response, return it
            return r
        } else {
            // it's not a response but could be a modified request
            request = r
        }
    } else if (plugin) {
        console.log("plugin issue", plugin)
    }

    // static assets
    if (isStatic(request.uri)) {
        console.log("handler event - static", request.uri)
        return request
    }

    // prerendered pages and index.html files - remove leading and/or trailing slash
    if (isInManifest(request.uri.replace(/(?<=^)\/|\/(?=$)/g, ''))) {
        console.log("handler event - prerendered", request.uri)
        return request
    }

    console.log("handler event - rendering", JSON.stringify(request))

    let bodyParm = {}

    if (!['HEAD', 'GET'].includes(request.method)) {
        bodyParm.body = request.body.encoding == "base64" ? Buffer.from(request.body.data, 'base64').toString('utf8') : request.body
    }

    //    console.log("handler event - bodyParm", bodyParm)

    const originKey = Object.keys(request.origin)[0]

    const stdRequest = new Request(`${request.origin[originKey].protocol ?? 'https'}://${request.origin[originKey].domainName}` + request.uri + querystring, {
        ...bodyParm,
        method: request.method,
        headers: Object.values({ ...request.headers, ...(request.origin[originKey].customHeaders ?? {}) }).reduce((acc, item) => {
            item.forEach((hdr) => acc.append(hdr.key, hdr.value))
            return acc
        }, new Headers())
    })

    //    console.log("handler event - standard request", stdRequest)

    const response = await server.respond(stdRequest, {
        platform: {},
        getClientAddress: () => request.clientIp,
        manifest
    });

    console.log("handler rendered", response, JSON.stringify(Array.from(response.headers.entries())))

    let resp
    if (response) {
        resp = {
            // mark any ssr rendered pages as non-cacheable
            headers: { "cache-control": [{ key: "Cache-Control", value: 'no-store' }] },
            body: await response.text(),
            status: response.status
        }
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-restrictions.html#lambda-at-edge-function-restrictions
        response.headers.forEach((value, key) => {
            if (![ // readonly headers for origin request
                'accept-encoding',
                'content-length',
                'if-modified-since',
                'if-none-match',
                'if-range',
                'if-unmodified-since',
                'transfer-encoding',
                'via'
            ].includes(key.toLowerCase())) {
                resp.headers[key.toLowerCase()] = [{ key, value }]
            } else {
                console.log("Removing read-only header", key)
            }
        })
    } else {
        resp = {
            status: 404,
            body: 'Not found.'
        }
    }
    console.log("response", resp)
    return resp
}

module.exports = {
    cf_origin_request_handler: cf_origin_request_handler,
    apigw_handler: apigw_handler
}