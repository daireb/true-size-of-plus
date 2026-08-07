/**
 * Build the map datasets from Natural Earth 1:10m.
 *
 * world-atlas only publishes 110m and 50m countries and no regions at all, so
 * both tiers are built here: fetch the raw GeoJSON, drop every property except
 * the ones we display, and convert to quantized TopoJSON (which delta-encodes
 * shared borders and is far smaller than the source GeoJSON).
 *
 * Run: node scripts/build-data.mjs
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { topology } from 'topojson-server'

const BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'
const QUANTIZATION = 1e6 // ~40 m at the equator

const SOURCES = [
  {
    object: 'countries',
    src: `${BASE}/ne_10m_admin_0_countries.geojson`,
    cache: 'scripts/.cache-ne10m-admin0.geojson',
    out: 'public/data/countries-10m.json',
    // NAME is the short display name ("Ireland", not "Republic of Ireland").
    props: (p) => ({ name: p.NAME ?? p.ADMIN }),
  },
  {
    object: 'regions',
    src: `${BASE}/ne_10m_admin_1_states_provinces.geojson`,
    cache: 'scripts/.cache-ne10m-admin1.geojson',
    out: 'public/data/regions-10m.json',
    // `admin` is the parent country. Essential, not decorative: 28 region
    // names collide with country names (Belgium has a Luxembourg province,
    // Nigeria has a Niger state) and 95 repeat across countries.
    props: (p) => ({ name: p.name, admin: p.admin }),
  },
]

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

for (const s of SOURCES) {
  let raw
  if (existsSync(s.cache)) {
    console.log(`${s.object}: using cached source`)
    raw = readFileSync(s.cache, 'utf8')
  } else {
    console.log(`${s.object}: downloading…`)
    const res = await fetch(s.src)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    raw = await res.text()
    writeFileSync(s.cache, raw)
  }

  const gj = JSON.parse(raw)
  const before = gj.features.length
  gj.features = gj.features
    .map((f) => ({
      type: 'Feature',
      properties: s.props(f.properties),
      geometry: f.geometry,
    }))
    .filter((f) => f.properties.name) // a handful of admin_1 rows are unnamed

  const topo = topology({ [s.object]: gj }, QUANTIZATION)
  const json = JSON.stringify(topo)
  writeFileSync(s.out, json)
  console.log(
    `${s.object}: ${gj.features.length} features (${before - gj.features.length} dropped) -> ${s.out}, ${mb(Buffer.byteLength(json))} from ${mb(raw.length)}`
  )
}
