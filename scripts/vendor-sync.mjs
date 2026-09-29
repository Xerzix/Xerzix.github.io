// Copies browser builds of third-party libraries from node_modules into js/vendor/
// so the site runs without a bundler and without third-party CDNs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'js', 'vendor');
mkdirSync(vendor, { recursive: true });

const hlsPkg = JSON.parse(readFileSync(join(root, 'node_modules/hls.js/package.json'), 'utf8'));
// Drop the sourceMappingURL comment: the map is not vendored, and a dangling reference 404s in devtools.
const hlsSource = readFileSync(join(root, 'node_modules/hls.js/dist/hls.min.mjs'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
writeFileSync(join(vendor, 'hls.min.mjs'), hlsSource);
copyFileSync(join(root, 'node_modules/hls.js/LICENSE'), join(vendor, 'hls.LICENSE.txt'));
writeFileSync(join(vendor, 'VERSIONS.json'), JSON.stringify({ 'hls.js': hlsPkg.version }, null, 2) + '\n');
console.log(`Vendored hls.js ${hlsPkg.version}`);
