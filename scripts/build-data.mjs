/**
 * Build public/data/countries-10m.json from Natural Earth 1:10m.
 *
 * world-atlas only publishes 110m and 50m, so the highest-detail tier is built
 * here: fetch the raw 10m GeoJSON, drop every property except the name, and
 * convert to quantized TopoJSON (which delta-encodes shared borders and is far
 * smaller than the source GeoJSON).
 *
 * Run: node scripts/build-data.mjs
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { topology } from 'topojson-server'

const SRC =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'
const CACHE = 'scripts/.cache-ne10m.geojson'
const OUT = 'public/data/countries-10m.json'
const QUANTIZATION = 1e6 // ~40 m at the equator

mkdirSync('scripts', { recursive: true })

let raw
if (existsSync(CACHE)) {
  console.log('using cached source')
  raw = readFileSync(CACHE, 'utf8')
} else {
  console.log('downloading Natural Earth 1:10m (~13 MB)…')
  const res = await fetch(SRC)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  raw = await res.text()
  writeFileSync(CACHE, raw)
}

const gj = JSON.parse(raw)
console.log(`source features: ${gj.features.length}`)

// Match the 50m dataset's shape: a single `name` property, nothing else.
// Natural Earth's NAME field is the short display name ("Ireland", not
// "Republic of Ireland"), which is what the search box wants.
gj.features = gj.features.map((f) => ({
  type: 'Feature',
  properties: { name: f.properties.NAME ?? f.properties.ADMIN },
  geometry: f.geometry,
}))

const topo = topology({ countries: gj }, QUANTIZATION)
writeFileSync(OUT, JSON.stringify(topo))

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(`wrote ${OUT} — ${mb(Buffer.byteLength(JSON.stringify(topo)))} (source was ${mb(raw.length)})`)
