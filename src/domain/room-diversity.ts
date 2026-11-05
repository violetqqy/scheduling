import type { Database, Version } from './types'
import { daysInMonth } from './dates'
import { key } from './model'

// Count actual ordinary shifts in this month, including preserved future cells.
// Custom shifts and overtime have no ordinary room and cannot satisfy this goal.
export function monthlyRooms(db: Database, version: Version, employeeId: string): Map<string, number> {
  const rooms = new Map<string, number>()
  for (const date of daysInMonth(version.month)) {
    const cell = version.cells[key(employeeId, date)]
    const room = cell?.kind === 'shift' ? db.shifts.find(s => s.id === cell.shiftId)?.roomId : undefined
    if (room) rooms.set(room, (rooms.get(room) || 0) + 1)
  }
  return rooms
}
