/**
 * End-to-end test of shape tracing: trace on an image canvas -> save -> place
 * on the same canvas and on Earth -> trace on Earth -> place on the image
 * canvas -> persistence -> deletion cascades.
 *
 * Run: node scripts/smoke-trace.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await page.waitForTimeout(2000)

// --- set up a calibrated canvas: 4000px / 2000 mi -> 0.8047 km/px -----------
await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 4000
  c.height = 2500
  const g = c.getContext('2d')
  g.fillStyle = '#3d6b52'
  g.fillRect(0, 0, 4000, 2500)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'traceworld.png', { type: 'image/png' }))
  const input = document.querySelector('[data-testid=canvas-file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(800)
const clickWorld = async (wx, wy) => {
  const [sx, sy] = await page.evaluate((p) => window.__flat.screenFromWorld(p), [wx, wy])
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(120)
}
await clickWorld(1000, 1250)
await clickWorld(3000, 1250)
await page.fill('.distance input', '1000')
await page.selectOption('.distance select', 'mi')
await page.click('.calibrate button.primary')
await page.waitForTimeout(300)
const KPP = (1000 * 1.609344) / 2000 // 0.8047 km/px

// --- trace with editing: wrong corner fixed by drag, edge insert, islands ---
console.log('--- trace on the image canvas ---')
await page.click('[data-testid=trace-start]') // start tracing
check('trace toolbar appears', await page.isVisible('.tracebar'))

// Rectangle corners, with the third deliberately wrong (2200 instead of 2400).
await clickWorld(1400, 600)
await clickWorld(2400, 600)
await clickWorld(2200, 1100)
check('3 points placed', (await page.textContent('.tracebar .count')).includes('3 pts'))

// Press-drag on empty space must pan the map, not add a point.
const vpA = await page.evaluate(() => window.__flat.viewport())
await page.mouse.move(900, 700)
await page.mouse.down()
await page.mouse.move(840, 660, { steps: 4 })
await page.mouse.up()
const vpB = await page.evaluate(() => window.__flat.viewport())
const tPan = await page.evaluate(() => window.__flat.trace())
check('drag pans instead of adding a point',
  Math.abs(vpB.tx - vpA.tx + 60) < 2 && tPan.picks.length === 3,
  `dtx ${(vpB.tx - vpA.tx).toFixed(0)}, ${tPan.picks.length} picks`)

// Ctrl+Z removes the last point.
await clickWorld(1800, 900) // a stray 4th point
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
check('Ctrl+Z undoes the last point',
  (await page.evaluate(() => window.__flat.trace())).picks.length === 3)

await clickWorld(1400, 1100) // proper 4th corner

// Fix the wrong corner by dragging the vertex into place.
const vFrom = await page.evaluate(() => window.__flat.screenFromWorld([2200, 1100]))
const vTo = await page.evaluate(() => window.__flat.screenFromWorld([2400, 1100]))
await page.mouse.move(vFrom[0], vFrom[1])
await page.mouse.down()
await page.mouse.move(vTo[0], vTo[1], { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(150)
const afterMove = await page.evaluate(() => window.__flat.trace())
check('vertex dragged into place',
  Math.abs(afterMove.picks[2][0] - 2400) < 8 && Math.abs(afterMove.picks[2][1] - 1100) < 8,
  `corner now ${afterMove.picks[2].map(Math.round)}`)

// Undo treats the whole drag as one step and restores the old position.
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
const unMoved = await page.evaluate(() => window.__flat.trace())
check('Ctrl+Z undoes a vertex move', Math.abs(unMoved.picks[2][0] - 2200) < 8,
  `corner back at ${unMoved.picks[2].map(Math.round)}`)
await page.mouse.move(vFrom[0], vFrom[1])
await page.mouse.down()
await page.mouse.move(vTo[0], vTo[1], { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(150)

// Click on the top edge inserts a point there (index 1, between its ends).
const eMid = await page.evaluate(() => window.__flat.screenFromWorld([1900, 600]))
await page.mouse.click(eMid[0], eMid[1])
await page.waitForTimeout(150)
const afterInsert = await page.evaluate(() => window.__flat.trace())
check('click on an edge inserts a point there',
  afterInsert.picks.length === 5 && Math.abs(afterInsert.picks[1][0] - 1900) < 8 &&
    Math.abs(afterInsert.picks[1][1] - 600) < 8,
  `${afterInsert.picks.length} picks, inserted at ${afterInsert.picks[1].map(Math.round)}`)

// Undo removes the inserted point — not the last-appended one.
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
const unInserted = await page.evaluate(() => window.__flat.trace())
check('Ctrl+Z undoes an edge insert',
  unInserted.picks.length === 4 && Math.abs(unInserted.picks[1][0] - 2400) < 8,
  `${unInserted.picks.length} picks, picks[1] = ${unInserted.picks[1].map(Math.round)}`)
await page.mouse.click(eMid[0], eMid[1]) // re-insert and carry on
await page.waitForTimeout(150)

// Double-click deletes a vertex; undo brings it back.
await page.mouse.dblclick(eMid[0], eMid[1])
await page.waitForTimeout(150)
const afterDel = await page.evaluate(() => window.__flat.trace())
check('double-click deletes a vertex', afterDel.picks.length === 4, `${afterDel.picks.length} picks`)
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
const restored = await page.evaluate(() => window.__flat.trace())
check('Ctrl+Z restores a deleted vertex',
  restored.picks.length === 5 && Math.abs(restored.picks[1][0] - 1900) < 8,
  `${restored.picks.length} picks, picks[1] = ${restored.picks[1].map(Math.round)}`)

// Right-click deletes too, and missing a vertex with it is a harmless no-op.
await page.mouse.click(eMid[0] + 60, eMid[1] + 60, { button: 'right' })
await page.waitForTimeout(150)
check('right-click off-vertex does nothing',
  (await page.evaluate(() => window.__flat.trace())).picks.length === 5)
await page.mouse.click(eMid[0], eMid[1], { button: 'right' })
await page.waitForTimeout(150)
check('right-click deletes a vertex',
  (await page.evaluate(() => window.__flat.trace())).picks.length === 4)
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)

// Second island.
await page.click('.tracebar button[title^="Finish"]')
check('island committed', (await page.evaluate(() => window.__flat.trace())).rings.length === 1)

// Undo re-opens the committed island.
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
const unIsland = await page.evaluate(() => window.__flat.trace())
check('Ctrl+Z undoes an island commit', unIsland.rings.length === 0 && unIsland.picks.length === 5,
  `${unIsland.rings.length} rings, ${unIsland.picks.length} picks`)
await page.click('.tracebar button[title^="Finish"]')
await clickWorld(2600, 1400)
await clickWorld(3100, 1400)
await clickWorld(3100, 1700)
await clickWorld(2600, 1700)
check('count shows 2 islands', (await page.textContent('.tracebar .count')).includes('2 islands'))

await page.fill('.tracebar input', 'Testlands')
await page.click('.tracebar button.primary')
await page.waitForTimeout(400)

// (1000x500 + 500x300) px² at 0.8047 km/px -> 420,922 km².
const expectedArea = (1000 * 500 + 500 * 300) * KPP * KPP
const row = (await page.textContent('.shapelist li .meta')).replace(/\s+/g, ' ')
const gotArea = Number(row.match(/([\d,]+) km²/)?.[1].replace(/,/g, ''))
check('archipelago saved with summed area (~420,900 km²)',
  row.includes('Testlands') && Math.abs(gotArea - expectedArea) / expectedArea < 0.015,
  `${row} (expected ~${Math.round(expectedArea).toLocaleString()})`)
check('trace mode exits after save', !(await page.isVisible('.tracebar')))

// --- auto-spawn at its traced position -------------------------------------------
console.log('--- auto-spawn and home ---')
check('freshly traced shape spawns in', await page.evaluate(() => window.__flat.count()) === 1)
// Area-weighted centroid of the two islands: (2119, 1012) image px.
const spawn = await page.evaluate(() => window.__flat.items()[0].target)
check('spawns exactly where it was traced',
  Math.abs(spawn[0] - 2119) < 10 && Math.abs(spawn[1] - 1012) < 10,
  `target ${spawn.map(Math.round)}`)

// Drag it away, then send it home from the expanded row.
const sp = await page.evaluate(() => window.__flat.screenFromWorld(window.__flat.items()[0].target))
await page.mouse.move(sp[0], sp[1])
await page.mouse.down()
await page.mouse.move(sp[0] + 120, sp[1] + 60, { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(200)
await page.click('.placed li .row')
await page.waitForTimeout(150)
await page.click('button[title="Send home — reset position and rotation"]')
await page.waitForTimeout(200)
const homed = await page.evaluate(() => window.__flat.items()[0].target)
check('send home returns it to the traced spot',
  Math.abs(homed[0] - 2119) < 10 && Math.abs(homed[1] - 1012) < 10,
  `target ${homed.map(Math.round)}`)
await page.mouse.click(1250, 60) // deselect
await page.waitForTimeout(150)

console.log('--- place on image canvas ---')
const bbox = await page.evaluate(() => window.__flat.bboxPx(window.__flat.items()[0].uid))
check('placed at its traced footprint (1700x1100 img px)',
  Math.abs(bbox.w - 1700) < 12 && Math.abs(bbox.h - 1100) < 12, `${bbox.w.toFixed(1)}x${bbox.h.toFixed(1)} px`)
check('row shows in placed list', (await page.textContent('.placed li .meta')).includes('Testlands'))

// --- place it on Earth -----------------------------------------------------------
await page.click('.chip') // Earth
await page.waitForTimeout(1200)
await page.click('.shapelist li button[title="Place Testlands"]')
await page.waitForTimeout(1500)
console.log('--- place on Earth ---')
check('Earth placed list gains the shape',
  (await page.textContent('.placed li .meta') ?? '').includes('Testlands'))
const drawn = await page.evaluate(() =>
  window.__map.queryRenderedFeatures({ layers: ['countries-active-fill', 'countries-static-fill'] }).length
)
check('shape renders on Earth', drawn > 0, `${drawn} features`)

// --- trace on Earth ---------------------------------------------------------------
console.log('--- trace on Earth ---')
// Pin the camera so the trace points project on-screen and clear of the panel.
await page.evaluate(() => window.__map.jumpTo({ center: [-14, 64.5], zoom: 4 }))
await page.waitForTimeout(600)
await page.click('[data-testid=trace-start]')
await page.waitForTimeout(300)
// A patch over the north Atlantic, ~roughly Iceland-sized.
for (const [lon, lat] of [[-24, 63], [-16, 63], [-16, 66], [-24, 66]]) {
  const pt = await page.evaluate(([ln, lt]) => window.__map.project([ln, lt]), [lon, lat])
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(120)
}
// Double-click delete works on Earth too; the toolbar counter is the witness.
const lastPt = await page.evaluate(() => window.__map.project([-24, 66]))
await page.mouse.dblclick(lastPt.x, lastPt.y)
await page.waitForTimeout(200)
check('double-click deletes a vertex on Earth',
  (await page.textContent('.tracebar .count')).includes('3 pts'))
await page.mouse.click(lastPt.x, lastPt.y)
await page.waitForTimeout(200)
check('re-adding the corner works', (await page.textContent('.tracebar .count')).includes('4 pts'))

await page.fill('.tracebar input', 'EarthPatch')
await page.click('.tracebar button.primary')
await page.waitForTimeout(400)
const rows = await page.$$eval('.shapelist li .meta', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')))
check('second shape saved from Earth trace', rows.some((r) => r.includes('EarthPatch')), rows.join(' | '))
check('provenance hidden on its own canvas', !rows.some((r) => r.includes('from Earth')), rows.join(' | '))
// ~8° lon x 3° lat at 64.5N: ≈ 385 km x 334 km ≈ 128,000 km²
const patchArea = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.shapelist li .meta')].find((e) => e.textContent.includes('EarthPatch'))
  return el.textContent
})
check('Earth trace area plausible (~128k km²)', /1[12][0-9],\d{3} km²/.test(patchArea), patchArea.replace(/\s+/g, ' '))

// --- place the Earth trace on the image canvas ------------------------------------
await page.click('.chipwrap .chip')
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(600)
check('provenance shows where it differs', (await page.$$eval('.shapelist li .meta',
  (els) => els.map((e) => e.textContent))).some((r) => r.includes('from Earth')))
await page.click('.shapelist li button[title="Place EarthPatch"]')
await page.waitForTimeout(300)
console.log('--- cross-canvas ---')
check('image canvas now has both subjects', await page.evaluate(() => window.__flat.count()) === 2)
const pb = await page.evaluate(() => window.__flat.bboxPx(window.__flat.items()[1].uid))
// 385 km / 0.8047 ≈ 478 px wide, 334 km / 0.8047 ≈ 415 px tall
check('Earth trace lands true-sized (~478x415 img px)',
  Math.abs(pb.w - 478) < 25 && Math.abs(pb.h - 415) < 25, `${pb.w.toFixed(0)}x${pb.h.toFixed(0)} px`)

// --- persistence --------------------------------------------------------------------
await page.waitForTimeout(700)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__flat, null, { timeout: 20000 })
await page.waitForTimeout(1500)
console.log('--- persistence ---')
check('shapes survive reload', await page.$$eval('.shapelist li', (els) => els.length) === 2)
check('placed shapes rehydrate', await page.evaluate(() => window.__flat.count()) === 2)

// --- deletion: confirm dialog, cascade, undo -----------------------------------
console.log('--- deletion ---')
await page.click('.shapelist li button[title="Delete Testlands"]')
await page.waitForTimeout(200)
check('delete asks for confirmation naming the shape',
  await page.isVisible('.modal') && (await page.textContent('.modal')).includes('Testlands'))
await page.click('.modal button:not(.danger)') // Cancel
await page.waitForTimeout(200)
check('cancel keeps the shape', await page.$$eval('.shapelist li', (els) => els.length) === 2)

await page.click('.shapelist li button[title="Delete Testlands"]')
await page.click('.modal button.danger')
await page.waitForTimeout(300)
check('confirmed delete removes the shape', await page.$$eval('.shapelist li', (els) => els.length) === 1)
check('its placements evict too', await page.evaluate(() => window.__flat.count()) === 1)
check('undo offered', await page.isVisible('.undo'))

await page.click('.undo button')
await page.waitForTimeout(300)
check('undo restores the shape', await page.$$eval('.shapelist li', (els) => els.length) === 2)
check('undo restores its placements', await page.evaluate(() => window.__flat.count()) === 2)

await page.click('.shapelist li button[title="Delete Testlands"]')
await page.click('.modal button.danger')
await page.waitForTimeout(300)
check('shape removed from library', await page.$$eval('.shapelist li', (els) => els.length) === 1)

// Clean up: delete the test canvas and the remaining shape (via the dialog).
await page.click('.shapelist li button[title="Delete EarthPatch"]')
await page.click('.modal button.danger')
await page.click('[data-testid=map-settings]')
await page.click('button[title="Delete map"]')
await page.click('.modal button.danger')
await page.waitForTimeout(400)

console.log('\nconsole errors:', errors.length ? errors : 'none')
if (errors.length) failures++
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
