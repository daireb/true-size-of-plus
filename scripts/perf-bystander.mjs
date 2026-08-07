/**
 * Reproduces the "dragging is laggy once a heavy country is sitting there"
 * case: place N heavy countries, leave them static, then drag a small one.
 * Frame times should be unaffected by the bystanders.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })

const add = async (name) => {
  await page.fill('.search input', name)
  await page.waitForSelector('.results button')
  await page.click('.results button')
  await page.waitForTimeout(1500)
}

const dragLast = async (label) => {
  // Grab the most recently added country (drawn last / on top).
  const grab = await page.evaluate(() => {
    const mp = window.__map
    const { width, height } = mp.getCanvas().getBoundingClientRect()
    const layers = mp.getStyle().layers.map((l) => l.id).filter((id) => id.includes('fill'))
    for (let y = 30; y < height - 30; y += 6)
      for (let x = 360; x < width - 30; x += 6)
        if (mp.queryRenderedFeatures([x, y], { layers }).length) return { x, y }
    return null
  })
  if (!grab) return console.log(`${label}: could not grab`)

  await page.evaluate(() => {
    window.__frames = []
    window.__stop = false
    let last = performance.now()
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
  for (let i = 1; i <= 40; i++)
    await page.mouse.move(grab.x + Math.sin(i / 4) * 100, grab.y + i * 6)
  await page.mouse.up()
  await page.evaluate(() => { window.__stop = true })

  const s = await page.evaluate(() => {
    const f = window.__frames.slice(2).sort((a, b) => a - b)
    return { median: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)], worst: f[f.length - 1] }
  })
  console.log(
    `${label.padEnd(38)} median ${s.median.toFixed(1)}ms  p95 ${s.p95.toFixed(1)}ms  worst ${s.worst.toFixed(1)}ms  (~${Math.round(1000 / s.median)}fps)`
  )
}

await add('Ireland')
await dragLast('drag Ireland, alone')

await add('Canada')
await page.waitForTimeout(1200)
await add('Ireland')
await dragLast('drag Ireland, Canada sitting static')

await add('Russia')
await add('United States of America')
await page.waitForTimeout(1200)
await add('Ireland')
await dragLast('drag Ireland, +Canada +Russia +USA static')

await browser.close()
