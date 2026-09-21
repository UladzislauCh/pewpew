import type { LabeledShot } from '../../domain/detection/labels'
import { WEAPON_IDS, weaponLabel } from '../../domain/detection/weapons'

interface ShotTableProps {
  shots: readonly (LabeledShot & { id?: string })[]
  selectedIndex: number | null
  selectedIndices: Set<number>
  onSelect: (index: number, multiSelect: boolean) => void
  onUpdate: (index: number, patch: Partial<LabeledShot>) => void
  onRemove: (index: number) => void
}

export function ShotTable({
  shots,
  selectedIndex,
  selectedIndices,
  onSelect,
  onUpdate,
  onRemove,
}: ShotTableProps) {
  if (shots.length === 0) {
    return (
      <p className="labeler__empty">
        No marks yet. Play the clip (0.25× works well) and press <kbd>A</kbd> on every shot —
        the mark lands exactly at the playhead, with no snapping.
      </p>
    )
  }

  return (
    <div className="labeler__table-container">
      <table className="shot-table">
        <thead>
          <tr>
            <th className="shot-table__checkbox-header" />
            <th>#</th>
            <th>Time</th>
            <th>Source</th>
            <th>Weapon</th>
            <th>Hard</th>
            <th>Note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shots.map((shot, index) => (
            <tr
              key={shot.id ?? `row-${index}`}
              className={`${index === selectedIndex ? 'shot-table__row--active' : ''}${selectedIndices.has(index) ? ' shot-table__row--checked' : ''}`}
              onClick={() => onSelect(index, false)}
            >
              <td className="shot-table__checkbox-cell">
                <input
                  type="checkbox"
                  checked={selectedIndices.has(index)}
                  onChange={(event) => {
                    event.stopPropagation()
                    onSelect(index, true)
                  }}
                  className="shot-table__checkbox"
                />
              </td>
              <td className="shot-table__index">{index + 1}</td>
              <td className="shot-table__time">{shot.time.toFixed(3)}</td>
              <td>
                <select
                  value={shot.source}
                  onChange={(event) => onUpdate(index, { source: event.target.value as LabeledShot['source'] })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <option value="own">own</option>
                  <option value="enemy">enemy</option>
                </select>
              </td>
              <td>
                <select
                  value={shot.weapon ?? ''}
                  onChange={(event) => onUpdate(index, { weapon: event.target.value || null })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <option value="">unknown</option>
                  {WEAPON_IDS.map((id) => (
                    <option key={id} value={id}>
                      {weaponLabel(id)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="shot-table__center">
                <input
                  type="checkbox"
                  checked={shot.hard}
                  onChange={(event) => {
                    onUpdate(index, { hard: event.target.checked })
                    event.stopPropagation()
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={shot.note ?? ''}
                  placeholder="—"
                  onChange={(event) => {
                    onUpdate(index, { note: event.target.value })
                    event.stopPropagation()
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="shot-table__remove"
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemove(index)
                  }}
                  aria-label="Delete mark"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
