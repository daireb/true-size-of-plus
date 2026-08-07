/** Measure drag frame times for the heaviest countries. Dev server must be up. */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })

for (const country of ['Canada', 'Russia', 'Ireland']) {
  await page.fill('.search input', country)
  await page.waitForSelector('.results button')
  await page.click('.results button')
  await page.waitForTimeout(2500)

  const grab = await page.evaluate(() => {
    const mp = window.__map
    const { width, height } = mp.getCanvas().getBoundingClientRect()
    for (let y = 30; y < height - 30; y += 8)
      for (let x = 360; x < width - 30; x += 8)
        if (mp.queryRenderedFeatures([x, y], { layers: ['placed-countries-fill'] }).length)
          return { x, y }
    return null
  })
  if (!grab) {
    console.log(`${country}: could not grab`)
    continue
  }

  await page.evaluate(() => {
    window.__frames = []
    let last = performance.now()
    window.__stop = false
    const tick = () => {
      const now = performance.now()
      window.__frames.push(now - last)
      last = now
      if (!window.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(grab.x + Math.sin(i / 4) * 120, grab.y + i * 8)
  }
  await page.mouse.up()
  await page.evaluate(() => { window.__stop = true })

  const stats = await page.evaluate(() => {
    const f = window.__frames.slice(2).sort((a, b) => a - b)
    const pct = (p) => f[Math.floor(f.length * p)]
    return { n: f.length, median: pct(0.5), p95: pct(0.95), worst: f[f.length - 1] }
  })
  const verts = await page.evaluate(() =>
    JSON.stringify(
      window.__map.getSource('placed-countries')._data ?? {}
    ).match(/-?\d+\.\d+/g)?.length ?? 0
  )
  console.log(
    `${country.padEnd(9)} median ${stats.median.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  worst ${stats.worst.toFixed(1)}ms  (~${Math.round(1000 / stats.median)}fps)`
  )

  // Remove it before the next one.
  await page.click('.placed li button[title="Remove"]')
  await page.waitForTimeout(300)
}

await browser.close()
