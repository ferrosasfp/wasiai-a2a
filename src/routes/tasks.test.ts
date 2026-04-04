/**
 * Tasks Routes Integration Tests — WKH-23
 * 17 integration tests via fastify.inject()
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import tasksRoutes from './tasks.js'
import type { Task } from '../types/index.js'

// ── Mock taskService ─────────────────────────────────────────
vi.mock('../services/task.js', () => ({
  taskService: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    updateStatus: vi.fn(),
    append: vi.fn(),
  },
  TaskNotFoundError: class TaskNotFoundError extends Error {
    constructor(id: string) {
      super(`Task '${id}' not found`)
      this.name = 'TaskNotFoundError'
    }
  },
  TerminalStateError: class TerminalStateError extends Error {
    constructor(id: string, state: string) {
      super(`Task '${id}' is in terminal state '${state}' and cannot be updated`)
      this.name = 'TerminalStateError'
    }
  },
}))

import { taskService, TaskNotFoundError, TerminalStateError } from '../services/task.js'

const mockCreate = vi.mocked(taskService.create)
const mockGet = vi.mocked(taskService.get)
const mockList = vi.mocked(taskService.list)
const mockUpdateStatus = vi.mocked(taskService.updateStatus)
const mockAppend = vi.mocked(taskService.append)

// ── Helpers ──────────────────────────────────────────────────

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: VALID_UUID,
    contextId: null,
    status: 'submitted',
    messages: [],
    artifacts: [],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ── Setup ─────────────────────────────────────────────────────

describe('tasks routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    await app.register(tasksRoutes, { prefix: '/tasks' })
    await app.ready()
  })

  afterAll(() => app.close())

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─ POST /tasks ────────────────────────────────────────────

  it('1. POST /tasks crea task y retorna 201', async () => {
    const task = makeTask()
    mockCreate.mockResolvedValue(task)

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { contextId: 'ctx-1', messages: [{ text: 'hi' }] },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe(VALID_UUID)
  })

  it('2. POST /tasks body vacío retorna 201 con defaults', async () => {
    const task = makeTask()
    mockCreate.mockResolvedValue(task)

    const res = await app.inject({ method: 'POST', url: '/tasks', payload: {} })

    expect(res.statusCode).toBe(201)
  })

  // ─ GET /tasks/:id ─────────────────────────────────────────

  it('3. GET /tasks/:id task existente retorna 200', async () => {
    const task = makeTask()
    mockGet.mockResolvedValue(task)

    const res = await app.inject({ method: 'GET', url: `/tasks/${VALID_UUID}` })

    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(VALID_UUID)
  })

  it('4. GET /tasks/:id task inexistente retorna 404', async () => {
    mockGet.mockResolvedValue(undefined)

    const res = await app.inject({ method: 'GET', url: `/tasks/${VALID_UUID}` })

    expect(res.statusCode).toBe(404)
  })

  // ─ GET /tasks ─────────────────────────────────────────────

  it('5. GET /tasks retorna lista 200', async () => {
    mockList.mockResolvedValue([makeTask()])

    const res = await app.inject({ method: 'GET', url: '/tasks' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tasks).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  it('6. GET /tasks?status=working filtra por status', async () => {
    mockList.mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: '/tasks?status=working' })

    expect(res.statusCode).toBe(200)
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'working' }),
    )
  })

  it('7. GET /tasks?status=xxx retorna 400 para status inválido', async () => {
    const res = await app.inject({ method: 'GET', url: '/tasks?status=INVALID' })

    expect(res.statusCode).toBe(400)
  })

  it('8. GET /tasks?context_id=abc filtra por context_id', async () => {
    mockList.mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: '/tasks?context_id=abc' })

    expect(res.statusCode).toBe(200)
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'abc' }),
    )
  })

  // ─ PATCH /tasks/:id/status ────────────────────────────────

  it('9. PATCH /tasks/:id/status válido retorna 200', async () => {
    const task = makeTask({ status: 'working' })
    mockUpdateStatus.mockResolvedValue(task)

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}/status`,
      payload: { status: 'working' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('working')
  })

  it('10. PATCH /tasks/:id/status inválido retorna 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}/status`,
      payload: { status: 'INVALID' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('11. PATCH /tasks/:id/status task inexistente retorna 404', async () => {
    mockUpdateStatus.mockRejectedValue(new TaskNotFoundError(VALID_UUID))

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}/status`,
      payload: { status: 'working' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('12. PATCH /tasks/:id/status en estado terminal retorna 409', async () => {
    mockUpdateStatus.mockRejectedValue(new TerminalStateError(VALID_UUID, 'completed'))

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}/status`,
      payload: { status: 'working' },
    })

    expect(res.statusCode).toBe(409)
  })

  // ─ PATCH /tasks/:id ───────────────────────────────────────

  it('13. PATCH /tasks/:id append messages retorna 200', async () => {
    const task = makeTask({ messages: [{ text: 'hello' }] })
    mockAppend.mockResolvedValue(task)

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}`,
      payload: { messages: [{ text: 'hello' }] },
    })

    expect(res.statusCode).toBe(200)
  })

  it('14. PATCH /tasks/:id append artifacts retorna 200', async () => {
    const task = makeTask({ artifacts: [{ url: 'file.txt' }] })
    mockAppend.mockResolvedValue(task)

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}`,
      payload: { artifacts: [{ url: 'file.txt' }] },
    })

    expect(res.statusCode).toBe(200)
  })

  it('15. PATCH /tasks/:id en estado terminal retorna 409', async () => {
    mockAppend.mockRejectedValue(new TerminalStateError(VALID_UUID, 'failed'))

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}`,
      payload: { messages: [{ text: 'x' }] },
    })

    expect(res.statusCode).toBe(409)
  })

  it('16. PATCH /tasks/:id sin messages ni artifacts retorna 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it('17. PATCH /tasks/:id task inexistente retorna 404', async () => {
    mockAppend.mockRejectedValue(new TaskNotFoundError(VALID_UUID))

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${VALID_UUID}`,
      payload: { messages: [{ text: 'x' }] },
    })

    expect(res.statusCode).toBe(404)
  })

  // ─ MNR-3: UUID inválido → 400 ─────────────────────────────

  it('18. GET /tasks/not-a-uuid retorna 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/tasks/not-a-uuid' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid UUID/)
  })

  it('19. PATCH /tasks/not-a-uuid/status retorna 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/not-a-uuid/status',
      payload: { status: 'working' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid UUID/)
  })

  it('20. PATCH /tasks/not-a-uuid retorna 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/not-a-uuid',
      payload: { messages: [{ text: 'x' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid UUID/)
  })
})
