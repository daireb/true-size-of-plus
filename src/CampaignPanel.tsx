import { useRef, useState } from 'react'
import type { useCampaignMap } from './lib/useCampaignMap'

type Campaign = ReturnType<typeof useCampaignMap>

export default function CampaignPanel({ c }: { c: Campaign }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [distance, setDistance] = useState('')
  const [unit, setUnit] = useState<'mi' | 'km'>('mi')

  const ready = c.picks?.length === 2

  return (
    <section className="campaign">
      <h2>Your map</h2>

      {!c.map ? (
        <div
          className={`drop${dragOver ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files[0]
            if (f) c.loadFile(f)
          }}
          onClick={() => fileRef.current?.click()}
        >
          <strong>Drop a campaign map</strong>
          <small>or click to choose · stays on your machine</small>
        </div>
      ) : (
        <>
          <div className="campaign-meta">
            <strong title={c.map.name}>{c.map.name}</strong>
            <small>
              {c.map.width.toLocaleString()} × {c.map.height.toLocaleString()} px
            </small>
            <small className="extent">
              {c.extent?.width} across · {c.extent?.height} tall
            </small>
          </div>

          {!c.calibrating ? (
            <div className="campaign-actions">
              <button className="primary" onClick={c.startCalibration}>
                Set scale
              </button>
              <button onClick={() => fileRef.current?.click()}>Replace</button>
              <button onClick={c.remove} title="Remove map">×</button>
            </div>
          ) : (
            <div className="calibrate">
              {!ready ? (
                <p>
                  Click <strong>two points</strong> on your map — along its scale
                  bar, or corner to corner if you know the width.
                  {c.picks?.length === 1 && ' Now the second point.'}
                </p>
              ) : (
                <>
                  <p>How far apart are those two points?</p>
                  <div className="distance">
                    <input
                      autoFocus
                      type="number"
                      min="0"
                      step="any"
                      value={distance}
                      placeholder="e.g. 100"
                      onChange={(e) => setDistance(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          c.applyCalibration(Number(distance), unit).then((ok) => ok && setDistance(''))
                      }}
                    />
                    <select value={unit} onChange={(e) => setUnit(e.target.value as 'mi' | 'km')}>
                      <option value="mi">miles</option>
                      <option value="km">km</option>
                    </select>
                  </div>
                </>
              )}
              <div className="campaign-actions">
                {ready && (
                  <button
                    className="primary"
                    onClick={() =>
                      c.applyCalibration(Number(distance), unit).then((ok) => ok && setDistance(''))
                    }
                  >
                    Apply
                  </button>
                )}
                <button onClick={c.cancelCalibration}>Cancel</button>
              </div>
            </div>
          )}

          <label className="opacity">
            <span>Opacity</span>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={c.opacity}
              onChange={(e) => c.setOpacity(Number(e.target.value))}
            />
          </label>
        </>
      )}

      {c.error && <p className="error">{c.error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) c.loadFile(f)
          e.target.value = ''
        }}
      />
    </section>
  )
}
