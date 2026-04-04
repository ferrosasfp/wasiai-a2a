/**
 * Task Service Unit Tests — WKH-23
 * 20 unit tests covering CRUD + terminal state guard + append
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock supabase BEFORE importing task service ──────────────
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { supabase } from '../lib/supabase.js'
import { taskService, TaskNotFoundError, TerminalStateError } from './task.js'
import type { Task } from '../types/index.js'

// ── Helpers ──────────────────────────────────────────────────

function makeTaskRow(overrides: Partial<{
  id: string
  context_id: string | null
  status: string
  messages: unknown[]
  artifacts: unknown[]
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    context_id: null,
    status: 'submitted',
    messages: [],
    artifacts: [],
    metadata: null,
    created_at: '2026-04-03T18:00:00.000Z',
    updated_at: '2026-04-03T18:00:00.000Z',
    ...overrides,
  }
}

// Chain builder for list() — limit() returns a thenable chain that also supports eq()
function makeListChain(result: { data: unknown; error: unknown }) {
  // Thenable terminal node that also supports .eq() for post-limit filters
  const terminal: Record<string, unknown> = {
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(result).then(res, rej),
  }
  const eqOnTerminal = vi.fn().mockReturnValue(terminal)
  terminal.eq = eqOnTerminal

  const eqFn = vi.fn()
  // eq() on the pre-limit chain returns terminal (for chaining after limit)
  eqFn.mockReturnValue(terminal)

  const limitFn = vi.fn().mockReturnValue(terminal)

  const chain: Record<string, unknown> = {
    select: vi.fn(),
    order: vi.fn(),
    limit: limitFn,
    eq: eqFn,
  }
  ;(chain.select as ReturnType<typeof vi.fn>).mockReturnValue(chain)
  ;(chain.order as ReturnType<typeof vi.fn>).mockReturnValue(chain)

  return chain
}

// Chain builder for Supabase fluent API mock
function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  const methods = ['from', 'insert', 'select', 'single', 'update', 'eq', 'order', 'limit', 'maybeSingle']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  // Terminal call: single() / maybeSingle() resolves
  ;(chain.single as ReturnType<typeof vi.fn>).mockResolvedValue(result)
  ;(chain.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(result)
  // list call: query object itself resolves
  Object.defineProperty(chain, 'then', {
    value: (res: (v: unknown) => void) => Promise.resolve(result).then(res),
    configurable: true,
  })
  return chain
}

const mockFrom = vi.mocked(supabase.from)

// ── Tests ────────────────────────────────────────────────────

describe('taskService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─ create ────────────────────────────────────────────────

  it('1. create() con body vacío retorna task con status submitted y arrays vacíos', async () => {
    const row = makeTaskRow()
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.create({})
    expect(task.status).toBe('submitted')
    expect(task.messages).toEqual([])
    expect(task.artifacts).toEqual([])
  })

  it('2. create() con todos los campos popula contextId, messages, artifacts, metadata', async () => {
    const row = makeTaskRow({
      context_id: 'ctx-1',
      messages: [{ text: 'hello' }],
      artifacts: [{ url: 'file.txt' }],
      metadata: { source: 'test' },
    })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.create({
      contextId: 'ctx-1',
      messages: [{ text: 'hello' }],
      artifacts: [{ url: 'file.txt' }],
      metadata: { source: 'test' },
    })

    expect(task.contextId).toBe('ctx-1')
    expect(task.messages).toHaveLength(1)
    expect(task.artifacts).toHaveLength(1)
    expect(task.metadata).toEqual({ source: 'test' })
  })

  // ─ get ───────────────────────────────────────────────────

  it('3. get() con ID existente retorna Task', async () => {
    const row = makeTaskRow({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(task).toBeDefined()
    expect(task?.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  it('4. get() con ID inexistente retorna undefined', async () => {
    const chain = mockChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.get('ffffffff-ffff-ffff-ffff-ffffffffffff')
    expect(task).toBeUndefined()
  })

  // ─ list ──────────────────────────────────────────────────

  it('5. list() sin filtros retorna array de tasks', async () => {
    const rows = [makeTaskRow(), makeTaskRow({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })]
    const chain = makeListChain({ data: rows, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    const tasks = await taskService.list()
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks).toHaveLength(2)
  })

  it('6. list() con filtro status llama eq con status', async () => {
    const result = { data: [], error: null }
    const chain = makeListChain(result)
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await taskService.list({ status: 'working' })
    // eq() is called on what limit() returns (terminal)
    const limitResult = (chain.limit as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(limitResult?.eq).toHaveBeenCalledWith('status', 'working')
  })

  it('7. list() con filtro contextId llama eq con context_id', async () => {
    const chain = makeListChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await taskService.list({ contextId: 'ctx-abc' })
    const limitResult = (chain.limit as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(limitResult?.eq).toHaveBeenCalledWith('context_id', 'ctx-abc')
  })

  it('8. list() con limit=2 pasa limit=2 a supabase', async () => {
    const chain = makeListChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await taskService.list({ limit: 2 })
    expect(chain.limit).toHaveBeenCalledWith(2)
  })

  it('9. list() con limit>100 clampea a 100', async () => {
    const chain = makeListChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await taskService.list({ limit: 999 })
    expect(chain.limit).toHaveBeenCalledWith(100)
  })

  // ─ updateStatus ──────────────────────────────────────────

  it('10. updateStatus() submitted→working retorna task con nuevo status', async () => {
    const currentRow = makeTaskRow({ status: 'submitted' })
    const updatedRow = makeTaskRow({ status: 'working' })

    // get() call
    const getChain = mockChain({ data: currentRow, error: null })
    // update() call
    const updateChain = mockChain({ data: updatedRow, error: null })

    mockFrom
      .mockReturnValueOnce(getChain as unknown as ReturnType<typeof mockFrom>)
      .mockReturnValueOnce(updateChain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.updateStatus('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'working')
    expect(task.status).toBe('working')
  })

  it('11. updateStatus() en estado completed lanza TerminalStateError', async () => {
    const row = makeTaskRow({ status: 'completed' })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.updateStatus('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'working'),
    ).rejects.toThrow(TerminalStateError)
  })

  it('12. updateStatus() en estado failed lanza TerminalStateError', async () => {
    const row = makeTaskRow({ status: 'failed' })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.updateStatus('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'working'),
    ).rejects.toThrow(TerminalStateError)
  })

  it('13. updateStatus() en estado canceled lanza TerminalStateError', async () => {
    const row = makeTaskRow({ status: 'canceled' })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.updateStatus('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'working'),
    ).rejects.toThrow(TerminalStateError)
  })

  it('14. updateStatus() con ID inexistente lanza TaskNotFoundError', async () => {
    const chain = mockChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.updateStatus('ffffffff-ffff-ffff-ffff-ffffffffffff', 'working'),
    ).rejects.toThrow(TaskNotFoundError)
  })

  // ─ append ────────────────────────────────────────────────

  it('15. append() messages los agrega (no reemplaza)', async () => {
    const currentRow = makeTaskRow({ messages: [{ text: 'original' }] })
    const updatedRow = makeTaskRow({ messages: [{ text: 'original' }, { text: 'new' }] })

    const getChain = mockChain({ data: currentRow, error: null })
    const updateChain = mockChain({ data: updatedRow, error: null })

    mockFrom
      .mockReturnValueOnce(getChain as unknown as ReturnType<typeof mockFrom>)
      .mockReturnValueOnce(updateChain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.append('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      messages: [{ text: 'new' }],
    })
    expect(task.messages).toHaveLength(2)
  })

  it('16. append() artifacts los agrega', async () => {
    const currentRow = makeTaskRow({ artifacts: [{ url: 'a.txt' }] })
    const updatedRow = makeTaskRow({ artifacts: [{ url: 'a.txt' }, { url: 'b.txt' }] })

    const getChain = mockChain({ data: currentRow, error: null })
    const updateChain = mockChain({ data: updatedRow, error: null })

    mockFrom
      .mockReturnValueOnce(getChain as unknown as ReturnType<typeof mockFrom>)
      .mockReturnValueOnce(updateChain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.append('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      artifacts: [{ url: 'b.txt' }],
    })
    expect(task.artifacts).toHaveLength(2)
  })

  it('17. append() messages + artifacts agrega ambos', async () => {
    const currentRow = makeTaskRow({ messages: [{ text: 'a' }], artifacts: [{ url: 'x' }] })
    const updatedRow = makeTaskRow({
      messages: [{ text: 'a' }, { text: 'b' }],
      artifacts: [{ url: 'x' }, { url: 'y' }],
    })

    const getChain = mockChain({ data: currentRow, error: null })
    const updateChain = mockChain({ data: updatedRow, error: null })

    mockFrom
      .mockReturnValueOnce(getChain as unknown as ReturnType<typeof mockFrom>)
      .mockReturnValueOnce(updateChain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.append('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      messages: [{ text: 'b' }],
      artifacts: [{ url: 'y' }],
    })
    expect(task.messages).toHaveLength(2)
    expect(task.artifacts).toHaveLength(2)
  })

  it('18. append() en estado terminal lanza TerminalStateError', async () => {
    const row = makeTaskRow({ status: 'completed' })
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.append('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { messages: [{ text: 'x' }] }),
    ).rejects.toThrow(TerminalStateError)
  })

  it('19. append() con ID inexistente lanza TaskNotFoundError', async () => {
    const chain = mockChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    await expect(
      taskService.append('ffffffff-ffff-ffff-ffff-ffffffffffff', { messages: [{ text: 'x' }] }),
    ).rejects.toThrow(TaskNotFoundError)
  })

  // ─ MNR-4: input-required no es estado terminal ───────────

  it('20. updateStatus() de input-required a working NO lanza TerminalStateError', async () => {
    const currentRow = makeTaskRow({ status: 'input-required' })
    const updatedRow = makeTaskRow({ status: 'working' })

    const getChain = mockChain({ data: currentRow, error: null })
    const updateChain = mockChain({ data: updatedRow, error: null })

    mockFrom
      .mockReturnValueOnce(getChain as unknown as ReturnType<typeof mockFrom>)
      .mockReturnValueOnce(updateChain as unknown as ReturnType<typeof mockFrom>)

    const task = await taskService.updateStatus('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'working')
    expect(task.status).toBe('working')
  })

  it('21. append() sin messages ni artifacts retorna task sin cambios', async () => {
    const row = makeTaskRow()
    const chain = mockChain({ data: row, error: null })
    mockFrom.mockReturnValue(chain as unknown as ReturnType<typeof mockFrom>)

    // Should only call get(), no update
    const task = await taskService.append('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {})
    expect(task.id).toBe(row.id)
    // Only one from() call (get), not two (get + update)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })
})
