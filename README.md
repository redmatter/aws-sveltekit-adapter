## aws-sveltekit-adapter

The purpose of this package is to allow sveltkit apps to be straightforwardly integrated into AWS projects.

### prerequisites

Node (version 18 or better) and npm need to be installed
A sveltekit app

### Usage

Your sveltekit app will contain a `svelte.config.js` file which creates a build configuration for sveltekit. This invokes the adapter, so this is where you need to set it up.

1. install the adapter into your app: `npm i --save-dev @natterbox/aws-sveltekit-adapter`
2. in `svelte.config.js` import the adapter, eg: `const adapter = import('@natterbox/aws-sveltekit-adapter');`
3. write the adapter in config into the `kit` configuration.

Here's a sample `svelte.config.js`

```javascript
const adapter_module = await import(process.env.DEV ? '@sveltejs/adapter-node' : '@natterbox/aws-sveltekit-adapter')
const adapter = adapter_module.default
import { vitePreprocess } from '@sveltejs/kit/vite';
import * as fs from 'fs';


/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ['.svelte'],
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: [vitePreprocess()],

	vitePlugin: {
		inspector: true,
	},
	kit: {
		adapter: adapter({
			builddir: 'build', // where in the app directory the final built files are located
			ext_modules: [], // extra modules that for some reason aren't being picked up in the build can be put here
			params: null, // parameters to send to the SSR lambda function. none needed by default
			minify: true, // set to false or easier debug
			plugin: { // if you want to run a plugin in the SSR lambda before any processing is done, do it here
				source: "../../../openid-auth", // this is a path to a directory containing source for the plugin module
				// package: <name> // if you want to install a released package instead of using a source module, name it here
				// initData: this is used if present to initialise the plugin when it starts
				initData: JSON.parse(fs.readFileSync("../openid-auth-info/openid-auth-info.json", { encoding: 'utf8' }))
			}
		})
	}
};
export default config;
```

See the comments in the sample file for adapter configuration options.

### modifying and publishing

1. make any changes you need and commit them to the github repo.
2. run `npm version x.x.x` to update the version. This will update and tag the repo automatically
3. get a personal access token, write it into `.npmrc`, and run `npm publish`. the github rpm repo requires a 'classic' token, so:
   - log into the github portal
   - go to Settings (click your avatar) -> Developer Settings (bottom left) -> Personal Access Tokens -> Tokens (classic)
   - click 'Generate new token (classic)'
   - name your token (eg 'publish package'), and select 'write:packages', then click Generate Token
   - copy the generated token into the clipboard and paste it into the local `.npmrc` file. you should end up with a line like: 
    ```//npm.pkg.github.com/:_authToken=ghp_rU2...```
4. run `npm version x.x.x` where x.x.x is the version you want to publish
5. run `npm publish`
  
that's it

### using the aws-sveltekit-adapter in your projects

The process is similar that for publishing - you need to get a token and put it into your projects `.npmrc` file.

1. get a personal access token, write it into `.npmrc`, and run `npm publish`. the github rpm repo requires a 'classic' token, so:
   - log into the github portal
   - go to Settings (click your avatar) -> Developer Settings (bottom left) -> Personal Access Tokens -> Tokens (classic)
   - click 'Generate new token (classic)'
   - name your token (eg 'publish package'), and select 'write:packages', then click Generate Token
   - copy the generated token into the clipboard and paste it into the local `.npmrc` file. you should end up with a line like: 
    ```//npm.pkg.github.com/:_authToken=ghp_rU2...```
2. run `npm i [--save-dev] @natterbox/aws-sveltekit-adapter`

Note that github tokens run out after a certain period and you'll need to refresh

Try not to check github tokens in. Consider your `.npmrc` file to be local - add it to `.gitignore`

Happy Svelting!
