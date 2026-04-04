/**
 * Task Service — CRUD + terminal state guard + append messages/artifacts
 * WKH-23: A2A Protocol task management
 */

import type { Task, TaskState } from '../types/index.js'
import { TERMINAL_STATES } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// ── Tipo interno para filas de Supabase ─────────────────────

interface TaskRow {
  id: string
  context_id: string | null
  status: TaskState
  messages: unknown[]
  artifacts: unknown[]
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ── Helpers Row ↔ Domain ────────────────────────────────────

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    contextId: row.context_id,
    status: row.status,
    messages: row.messages,
    artifacts: row.artifacts,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

// ── Service ─────────────────────────────────────────────────

export const taskService = {
  /**
   * Create a new task (status defaults to 'submitted' via DB)
   */
  async create(input: {
    contextId?: string
    messages?: unknown[]
    artifacts?: unknown[]
    metadata?: Record<string, unknown>
  }): Promise<Task> {
    const row: Partial<TaskRow> = {}
    if (input.contextId !== undefined) row.context_id = input.contextId
    if (input.messages !== undefined) row.messages = input.messages
    if (input.artifacts !== undefined) row.artifacts = input.artifacts
    if (input.metadata !== undefined) row.metadata = input.metadata

    const { data, error } = await supabase
      .from('tasks')
      .insert(row)
      .select()
      .single()

    if (error) throw new Error(`Failed to create task: ${error.message}`)
    return rowToTask(data as TaskRow)
  },

  /**
   * Get a task by ID. Returns undefined if not found.
   */
  async get(id: string): Promise<Task | undefined> {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(`Failed to get task '${id}': ${error.message}`)
    return data ? rowToTask(data as TaskRow) : undefined
  },

  /**
   * List tasks with optional filters
   */
  async list(filters?: {
    status?: TaskState
    contextId?: string
    limit?: number
  }): Promise<Task[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 100)

    let query = supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (filters?.status) {
      query = query.eq('status', filters.status)
    }
    if (filters?.contextId) {
      query = query.eq('context_id', filters.contextId)
    }

    const { data, error } = await query

    if (error) throw new Error(`Failed to list tasks: ${error.message}`)
    return (data as TaskRow[]).map(rowToTask)
  },

  /**
   * Update task status with terminal state guard.
   * Throws if task is in a terminal state.
   */
  async updateStatus(id: string, status: TaskState): Promise<Task> {
    // 1. Fetch current task
    const current = await this.get(id)
    if (!current) throw new TaskNotFoundError(id)

    // 2. Terminal state guard
    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status)
    }

    // 3. Update status
    const { data, error } = await supabase
      .from('tasks')
      .update({ status })
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(`Failed to update task status: ${error.message}`)
    return rowToTask(data as TaskRow)
  },

  /**
   * Append messages and/or artifacts to a task.
   * Uses fetch-concat-update pattern (consistent with Supabase patterns in this project).
   *
   * ⚠️ Race condition conocida (CD-11): dos requests simultáneos pueden
   * perder datos porque el segundo update sobrescribe el array del primero.
   * Aceptado para v1 — fix futuro con `jsonb_concat` RPC o SELECT FOR UPDATE en v2.
   */
  async append(
    id: string,
    input: { messages?: unknown[]; artifacts?: unknown[] },
  ): Promise<Task> {
    // 1. Fetch current task
    const current = await this.get(id)
    if (!current) throw new TaskNotFoundError(id)

    // 2. Terminal state guard
    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status)
    }

    // 3. Build update payload with appended arrays
    const updateRow: Partial<Pick<TaskRow, 'messages' | 'artifacts'>> = {}
    if (input.messages?.length) {
      updateRow.messages = [...current.messages, ...input.messages]
    }
    if (input.artifacts?.length) {
      updateRow.artifacts = [...current.artifacts, ...input.artifacts]
    }

    if (Object.keys(updateRow).length === 0) {
      return current // nothing to append
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateRow)
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(`Failed to append to task: ${error.message}`)
    return rowToTask(data as TaskRow)
  },
}

// ── Custom Errors ───────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task '${id}' not found`)
    this.name = 'TaskNotFoundError'
  }
}

export class TerminalStateError extends Error {
  constructor(id: string, state: TaskState) {
    super(`Task '${id}' is in terminal state '${state}' and cannot be updated`)
    this.name = 'TerminalStateError'
  }
}
