/** Visual checks: upright dragging, rotation control, small-country detail. */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })

const add = async (name) => {
  await page.fill('.search input', name)
  await page.waitForSelector('.results button')
  await page.click('.results button')
  await page.waitForTimeout(1800)
}

// 1. Upright test: drag Greenland a long way east-west and down.
await add('Greenland')
await page.evaluate(() => window.__map.jumpTo({ center: [0, 25], zoom: 1.7 }))
await page.waitForTimeout(1500)
const grab = await page.evaluate(() => {
  const mp = window.__map
  const { width, height } = mp.getCanvas().getBoundingClientRect()
  for (let y = 30; y < height - 30; y += 8)
    for (let x = 360; x < width - 30; x += 8)
      if (mp.queryRenderedFeatures([x, y], { layers: ['countries-active-fill', 'countries-static-fill'] }).length)
        return { x, y }
  return null
})
await page.mouse.move(grab.x, grab.y)
await page.mouse.down()
// A deliberately wandering path — the case that used to accumulate spin.
for (let i = 1; i <= 30; i++)
  await page.mouse.move(grab.x + Math.sin(i / 3) * 200 + i * 6, grab.y + i * 9)
await page.mouse.up()
await page.waitForTimeout(1500)
await page.screenshot({ path: 'scripts/out-upright.png' })
console.log('upright test:', await page.evaluate(() => document.querySelector('.placed li .meta')?.innerText.replace(/\n/g, ' | ')))

// 2. Rotation control (slider lives in the expanded row now).
await page.click('.placed li .row')
await page.waitForTimeout(200)
await page.evaluate(() => {
  const s = document.querySelector('.rotate input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(s, '55')
  s.dispatchEvent(new Event('input', { bubbles: true }))
  s.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForTimeout(1500)
await page.screenshot({ path: 'scripts/out-rotated.png' })
console.log('rotation:', await page.evaluate(() => document.querySelector('.deg')?.textContent))

// 3. Small-country detail at 1:10m.
await page.click('.placed li .row button[title="Remove"]')
await add('Ireland')
await page.evaluate(() => window.__map.setZoom(5.6))
await page.waitForTimeout(2500)
await page.screenshot({ path: 'scripts/out-ireland10m.png' })

await browser.close()
