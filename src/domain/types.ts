export type Category = '早' | '中' | '晚' | '白' | '光子'
export type CellKind = 'shift' | 'custom' | 'overtime' | 'rest' | 'vacation' | 'leave' | 'unassigned'
export type Page = 'overview' | 'schedule' | 'employees' | 'shifts' | 'calendar' | 'import' | 'statistics' | 'settings'
export interface Employee { id: string; code: string; name: string; order: number; from: string; to: string; note: string }
export interface Room { id: string; name: string; color: string; ink: string }
export interface Shift { id: string; roomId: string; category: Category; enabled: boolean }
export interface OvertimeBase { kind: Exclude<CellKind,'overtime'>; shiftId?:string; customName?:string; locked: boolean; source: 'auto' | 'manual' | 'import' | 'calendar' | 'plan'; note?: string; planId?: string }
export interface Cell { kind: CellKind; shiftId?: string; customName?: string; locked: boolean; source: 'auto' | 'manual' | 'import' | 'calendar' | 'plan'; note?: string; planId?: string; overtimeBase?: OvertimeBase }
export interface RuleSettings { photonCarry: 'conflict' | 'continue'; leaveSplits: boolean; redYellowOrder?: boolean; monthlyRoomDiversity?: boolean; earlyLatePriority?: boolean; earlyLateCarry?: boolean; singleDayCredit?: boolean }
export interface Issue { id: string; rule: string; level: 'error' | 'warning'; message: string; date?: string; employeeId?: string; shiftId?: string }
export interface VacationImpact { employeeId: string; date: string; shiftId: string; segmentDates: string[] }
export interface SegmentBaseline { employeeId: string; start: string; dates: string[]; shiftId: string; excludedDates?:string[] }
export interface Version {
  id: string; month: string; name: string; status: 'draft' | 'confirmed' | 'imported';
  created: string; updated: string; cells: Record<string, Cell>; calendar: Record<string, boolean>; requirements: Record<string, number>;
  employeeIds: string[]; ruleSettings: RuleSettings; inputHash: string; sourceVersionId?: string; historyMode?: 'initial' | 'reference';
  vacationPlans: VacationPlan[]; vacationImpacts?: VacationImpact[]; manualMixedSegments?: string[]; segmentBaselines?: SegmentBaseline[]; parentId?: string; demo?: boolean; run?: { attempts: number; duration: number; fallbackId?: string; note: string; preparation?: {sourceVersionId?:string;carrySegments:number;pendingDebts:Debt[]} };
}
export interface VacationPlan { id: string; employeeId: string; month: string; dates: string[]; reason: string; source: 'manual' | 'import'; created: string; updated: string }
export interface Debt { id: string; employeeId: string; category: Category; origin: string; due: string; note: string }
export interface AuditLog { id: string; time: string; action: string; detail: string }
export interface Database {
  schema: 2; vacationPlans: VacationPlan[]; employees: Employee[]; rooms: Room[]; shifts: Shift[];
  calendar: Record<string, boolean>; demand: Record<string, boolean>;
  versions: Version[]; activeVersions: Record<string, string>; rules: RuleSettings;
  debts: Debt[]; logs: AuditLog[]; demo: boolean;
}
export interface Segment { id: string; employeeId: string; start: string; end: string; dates: string[]; bounded: boolean }
export interface GenerateResult { version: Version; issues: Issue[]; debts: Debt[] }
export interface DayCoverage { date: string; shiftId: string; expected: number; actual: number; employeeIds: string[]; gap: number; excess: number }
export interface ImportRow { row: number; employeeId?: string; code: string; name: string; date: string; cell?: Cell; raw: string; color: string; error: string; skip?: boolean }

export interface EmployeeImportRow { rawCode?: string; parseError?: string; row: number; code: string; name: string; order?: number; from: string; to: string; note: string; error: string; skip?: boolean; employeeId?: string }
