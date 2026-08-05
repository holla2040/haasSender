// Build one self-contained file for the controller's SD card.
//
// The board serves /www/index.html.gz at http://<board-ip>/ — the same slot
// ESP3D-WebUI occupies (93,373 bytes). Install with:
//   GET  /sdfiles?action=createdir&filename=www&path=/
//   POST /sdfiles   (multipart, filename /www/index.html.gz)
// Back up the existing index.html.gz first; it is the fallback if this misbehaves.

import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const BUDGET = 150 * 1024   // ESP3D-WebUI is ~91 KB gzipped; stay in that neighbourhood
const OUT = 'dist'

const bundle = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  legalComments: 'none'
})

const js = bundle.outputFiles[0].text
const css = await readFile('src/haas.css', 'utf8')
const html = await readFile('index.html', 'utf8')

let inlined = html
  // The import map only exists so the unbundled dev server can resolve lit-html;
  // esbuild has already inlined it here, and leaving the map in would 404.
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace(/<link rel="stylesheet" href="\.\/src\/haas\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/, () => `<script type="module">\n${js}\n</script>`)

for (const [what, present] of [['stylesheet link', /<style>/], ['module script', /<script type="module">/]]) {
  if (!present.test(inlined)) {
    console.error(`build: could not inline the ${what} — check index.html`)
    process.exit(1)
  }
}
if (/importmap|src="\.\/src\//.test(inlined)) {
  console.error('build: something still points at ./src — the bundle would 404 on the board')
  process.exit(1)
}

const gz = gzipSync(Buffer.from(inlined), { level: 9 })

await mkdir(OUT, { recursive: true })
await writeFile(`${OUT}/index.html`, inlined)
await writeFile(`${OUT}/index.html.gz`, gz)

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
console.log(`bundle   ${kb(js.length)}`)
console.log(`html     ${kb(inlined.length)}`)
console.log(`gzipped  ${kb(gz.length)}  (budget ${kb(BUDGET)})`)

if (gz.length > BUDGET) {
  console.error(`\nbuild: gzipped output is over budget by ${kb(gz.length - BUDGET)}.`)
  console.error('Either trim it or raise BUDGET deliberately — do not let this drift silently.')
  process.exit(1)
}
