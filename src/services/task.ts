/**
 * Task Service — CRUD + terminal state guard + append messages/artifacts
 * WKH-23: A2A Protocol task management
 * WKH-54: ownership isolation — every query filters by `owner_ref` to
 *         prevent cross-tenant reads/writes (same pattern as WKH-53 for
 *         a2a_agent_keys).
 *
 * Contract: every method requires `ownerRef` — the `owner_ref` of the
 * caller's A2A key row, obtained via `request.a2aKeyRow.owner_ref` in
 * routes. Rows matching the `id` but NOT the `ownerRef` are treated as
 * NOT FOUND (to avoid leaking existence to unauthorized owners).
 */

import { supabase } from '../lib/supabase.js';
import type { Task, TaskState } from '../types/index.js';
import { TERMINAL_STATES } from '../types/index.js';

// ── Tipo interno para filas de Supabase ─────────────────────

interface TaskRow {
  id: string;
  owner_ref: string;
  context_id: string | null;
  status: TaskState;
  messages: unknown[];
  artifacts: unknown[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
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
  };
}

// ── Service ─────────────────────────────────────────────────

export const taskService = {
  /**
   * Create a new task. `ownerRef` stamps the row for subsequent ownership
   * filtering. Caller MUST supply the authenticated caller's `owner_ref`.
   */
  async create(
    ownerRef: string,
    input: {
      contextId?: string;
      messages?: unknown[];
      artifacts?: unknown[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<Task> {
    const row: Partial<TaskRow> = { owner_ref: ownerRef };
    if (input.contextId !== undefined) row.context_id = input.contextId;
    if (input.messages !== undefined) row.messages = input.messages;
    if (input.artifacts !== undefined) row.artifacts = input.artifacts;
    if (input.metadata !== undefined) row.metadata = input.metadata;

    const { data, error } = await supabase
      .from('tasks')
      .insert(row)
      .select()
      .single();

    if (error) throw new Error(`Failed to create task: ${error.message}`);
    return rowToTask(data as TaskRow);
  },

  /**
   * Get a task by ID. Returns undefined if not found OR if the row exists
   * but belongs to another owner (deliberate: don't leak existence of other
   * tenants' tasks).
   */
  async get(ownerRef: string, id: string): Promise<Task | undefined> {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .maybeSingle();

    if (error) throw new Error(`Failed to get task '${id}': ${error.message}`);
    return data ? rowToTask(data as TaskRow) : undefined;
  },

  /**
   * List tasks scoped to `ownerRef`. Optional filters are additive.
   */
  async list(
    ownerRef: string,
    filters?: {
      status?: TaskState;
      contextId?: string;
      limit?: number;
    },
  ): Promise<Task[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 100);

    let query = supabase
      .from('tasks')
      .select('*')
      .eq('owner_ref', ownerRef)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }
    if (filters?.contextId) {
      query = query.eq('context_id', filters.contextId);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to list tasks: ${error.message}`);
    return (data as TaskRow[]).map(rowToTask);
  },

  /**
   * Update task status with terminal state guard.
   * Throws `TaskNotFoundError` if the task doesn't exist OR belongs to another
   * owner (existence not leaked).
   */
  async updateStatus(
    ownerRef: string,
    id: string,
    status: TaskState,
  ): Promise<Task> {
    // 1. Fetch current task scoped to owner (returns undefined if cross-tenant)
    const current = await this.get(ownerRef, id);
    if (!current) throw new TaskNotFoundError(id);

    // 2. Terminal state guard
    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status);
    }

    // 3. Update status — filter by owner_ref defense-in-depth
    const { data, error } = await supabase
      .from('tasks')
      .update({ status })
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .select()
      .single();

    if (error)
      throw new Error(`Failed to update task status: ${error.message}`);
    return rowToTask(data as TaskRow);
  },

  /**
   * Append messages and/or artifacts to a task (scoped to owner).
   *
   * ⚠️ Race condition conocida (CD-11): dos requests simultáneos pueden
   * perder datos porque el segundo update sobrescribe el array del primero.
   * Aceptado para v1 — fix futuro con `jsonb_concat` RPC o SELECT FOR UPDATE en v2.
   */
  async append(
    ownerRef: string,
    id: string,
    input: { messages?: unknown[]; artifacts?: unknown[] },
  ): Promise<Task> {
    const current = await this.get(ownerRef, id);
    if (!current) throw new TaskNotFoundError(id);

    if (TERMINAL_STATES.includes(current.status)) {
      throw new TerminalStateError(id, current.status);
    }

    const updateRow: Partial<Pick<TaskRow, 'messages' | 'artifacts'>> = {};
    if (input.messages?.length) {
      updateRow.messages = [...current.messages, ...input.messages];
    }
    if (input.artifacts?.length) {
      updateRow.artifacts = [...current.artifacts, ...input.artifacts];
    }

    if (Object.keys(updateRow).length === 0) {
      return current;
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateRow)
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .select()
      .single();

    if (error) throw new Error(`Failed to append to task: ${error.message}`);
    return rowToTask(data as TaskRow);
  },
};

// ── Custom Errors ───────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task '${id}' not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class TerminalStateError extends Error {
  constructor(id: string, state: TaskState) {
    super(`Task '${id}' is in terminal state '${state}' and cannot be updated`);
    this.name = 'TerminalStateError';
  }
}
