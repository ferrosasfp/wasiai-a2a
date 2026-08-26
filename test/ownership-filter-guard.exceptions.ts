/**
 * Las cadenas `select` / `update` / `delete` sobre tablas con `owner_ref` que
 * HOY no llevan filtro por dueño, con el motivo de cada una.
 *
 * ⛔ ESTA LISTA NO SE GENERA VOLCANDO LA SALIDA DEL ESCÁNER. Está escrita a
 * mano, entrada por entrada, leyendo el sitio. La razón no es ceremonia: un
 * artefacto derivado de la misma medición que consume deja el control verde
 * **por construcción** y no mide nada. Ya pasó en este repo (WKH-322, `T-U7`:
 * un test iteraba la allowlist exportada para afirmar que «todas están
 * permitidas»). La salida del escáner sirve como CHECKLIST de qué mirar; lo que
 * está prohibido es que `category` y `reason` salgan de un `console.log`.
 *
 * El desarrollo completo de cada motivo, con el `archivo:línea` del docblock que
 * lo dice cuando existe, está en
 * `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/censo-owner-ref.md`.
 *
 * ── CÓMO SE MANTIENE ───────────────────────────────────────────────────────
 *
 *  - Si agregás una consulta sin filtro de dueño, el guardián se pone rojo y te
 *    dice cómo ARREGLARLA. Exceptuarla es la última opción, no la primera.
 *  - Si el sitio de una excepción deja de existir, el guardián también se pone
 *    rojo: una lista que se pudre va perdiendo alcance sin avisar.
 *  - `category` y `reason` se validan en RUNTIME (G-10), no por tipo. Medido:
 *    `tsconfig.json:19` es `"include": ["src/**\/*"]` y `package.json:11` es
 *    `"lint": "biome check src/"`, así que a este archivo **no lo typechequea
 *    CI ni lo lintea nadie**. Un tipo que nadie evalúa es una promesa.
 */

/**
 * Unión CERRADA de categorías. Sale de leer los 55 sitios del censo, no de
 * inventarlas. G-10 rechaza en runtime cualquier `category` fuera de acá.
 */
export const OWNER_FILTER_CATEGORIES = [
  /** El caller elige el identificador y no hay chequeo de dueño en NINGÚN lado. */
  'idor-vivo',
  /** La consulta decide QUIÉN SOS; todavía no hay dueño contra el cual filtrar. */
  'auth-por-hash',
  /** El identificador sale de la fila que el caller ya autenticó, no del request. */
  'alcance-por-fila-del-caller',
  /** Catálogo compartido: se consulta igual para todos, por diseño. */
  'catalogo-publico',
  /** Lectura o escritura global detrás de un gate de admin. */
  'admin-cross-tenant',
  /** Barrido de fondo: no hay caller cuyo dueño usar. */
  'worker-sin-caller',
  /** Compare-and-set o idempotencia sobre un id derivado del servidor. */
  'ligadura-de-fila',
  /** Se lee sin filtro A PROPÓSITO y el dueño se compara después en JavaScript. */
  'chequeo-en-js',
  /** Pre-chequeo de unicidad que POR DEFINICIÓN cruza inquilinos. */
  'unicidad-global',
  /** La consulta no lee datos: sólo comprueba que la columna/tabla resuelva. */
  'probe-de-esquema',
  /** Falso positivo conocido por cadena partida en variable. Hoy: 0 sitios. */
  'punto-ciego-del-escaner',
] as const;

export type OwnerFilterCategory = (typeof OWNER_FILTER_CATEGORIES)[number];

export interface OwnershipFilterException {
  /** Ruta desde la raíz del repo. */
  file: string;
  /** Línea del `.from(`, que es la convención del censo. */
  line: number;
  table: string;
  verb: 'select' | 'update' | 'delete';
  category: OwnerFilterCategory;
  /** Por qué ESTE sitio no necesita el filtro. Nunca vacío (G-10). */
  reason: string;
}

export const OWNERSHIP_FILTER_EXCEPTIONS: OwnershipFilterException[] = [
  // ── probe-de-esquema (1) ────────────────────────────────────────────────
  {
    file: 'src/adapters/escrow/schema-preflight.ts',
    line: 142,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'select',
    category: 'probe-de-esquema',
    reason:
      'probeEscrowSchema sólo mira `col.error` para saber si PostgREST resuelve la columna ' +
      '`debit_hop2_attempted_at`. Nunca lee la fila que trae; el `limit(1)` es para que el costo ' +
      'no dependa del tamaño de la tabla. Filtrar por dueño no cambiaría nada de lo que observa.',
  },

  // ── auth-por-hash (4) ───────────────────────────────────────────────────
  {
    file: 'src/services/agent-link.ts',
    line: 243,
    table: 'a2a_agent_links',
    verb: 'select',
    category: 'auth-por-hash',
    reason:
      'lookupByTokenHash: el caller se autentica CON el token; el owner se deriva del row ' +
      'encontrado. Su propio docblock (:236-239) lo declara: "ÚNICA fn del mint/redeem sin owner ' +
      'gate. NO es IDOR".',
  },
  {
    file: 'src/services/delegation.ts',
    line: 271,
    table: 'a2a_delegations',
    verb: 'select',
    category: 'auth-por-hash',
    reason:
      'lookupByTokenHash por `session_token_hash`: es la consulta que resuelve la identidad de ' +
      'quien presenta el token de delegación. No hay dueño conocido antes de ejecutarla.',
  },
  {
    file: 'src/services/identity.ts',
    line: 93,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'auth-por-hash',
    reason:
      'lookupByHash resuelve la agent key desde el SHA-256 de la credencial presentada. Es el ' +
      'origen de TODO `owner_ref` del sistema: exigirle un filtro por dueño sería circular.',
  },
  {
    file: 'src/services/key-session.ts',
    line: 266,
    table: 'a2a_key_sessions',
    verb: 'select',
    category: 'auth-por-hash',
    reason:
      'lookupByTokenHash por `session_token_hash`. Docblock :260-262: "el caller se autentica CON ' +
      'el token; el owner se deriva del row. ÚNICA fn sin owner gate. NO es IDOR".',
  },

  // ── alcance-por-fila-del-caller (3) ─────────────────────────────────────
  {
    file: 'src/services/agent-link.ts',
    line: 265,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'alcance-por-fila-del-caller',
    reason:
      'getKeyById: el `keyId` sale del row del link que ya autenticó con el token, no del ' +
      'request. El caller no puede elegir qué key se carga.',
  },
  {
    file: 'src/services/delegation.ts',
    line: 293,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'alcance-por-fila-del-caller',
    reason:
      'getParentKey: el motivo está escrito en el propio código, en delegation.ts:288 — "NOTA ' +
      'PARA AR-CR: no es IDOR (key_id proviene del row de la delegación)".',
  },
  {
    file: 'src/services/key-session.ts',
    line: 286,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'alcance-por-fila-del-caller',
    reason:
      'getParentKey: docblock :280-282 — "el caller no eligió el key_id: sale del row de la ' +
      'sesión que autenticó con su token".',
  },

  // ── catalogo-publico (9) ────────────────────────────────────────────────
  {
    file: 'src/services/agent.ts',
    line: 372,
    table: 'a2a_agents',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'getSplitContextRow(slug) busca al dueño de un agente de un TERCERO para resolver su pata ' +
      'de creator en los splits: `owner_ref` es la columna que se LEE, no por la que se filtra. ' +
      'El resultado es server-side exclusivo y nunca entra a un shape público (docblock :359-364).',
  },
  {
    file: 'src/services/agent.ts',
    line: 507,
    table: 'a2a_agents',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'listAsAgents es la vista pública descubrible, acotada por `enabled = true`. Su docblock ' +
      ':503 lo dice: "NO filtra por owner — es la vista pública descubrible".',
  },
  {
    file: 'src/services/agent.ts',
    line: 547,
    table: 'a2a_agents',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'Anclas de discovery por lista de slugs, acotada por `enabled = true`. Los slugs que el ' +
      'caller pide son los del catálogo público que acaba de recibir.',
  },
  {
    file: 'src/services/agent.ts',
    line: 580,
    table: 'a2a_agents',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'getBySlugAsAgent: resolución pública de un agente por slug, acotada por `enabled = true`. ' +
      'Devuelve el shape público `Agent`, no el row.',
  },
  {
    file: 'src/services/identity.ts',
    line: 421,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'resolveIdentityForAgent trae SÓLO la columna `erc8004_identity` de keys activas, para la ' +
      'ficha pública de un agente. Ninguna columna de dinero ni PII (comentario en :422).',
  },
  {
    file: 'src/services/identity.ts',
    line: 471,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'resolveErc8004AgentId, mismo SELECT de una sola columna pública. Docblock :462-464: "NO es ' +
      'lectura por keyId del caller ni expone nada por ruta HTTP; NO es IDOR".',
  },
  {
    // ⚠️ 174 → 227 el 2026-08-26 (WKH-366 fix-pack). La cadena no se tocó: la
    // corrió el bloque `RESERVED_REGISTRY_IDS`, 53 líneas más arriba. Las tres
    // entradas de este archivo se re-derivaron ABRIENDO el archivo, no aplicando
    // el +53 a las tres (los desplazamientos NO son iguales: la de `getEnabled`
    // se corrió 62, porque además tiene el guard nuevo de `register` encima).
    file: 'src/services/registry.ts',
    line: 227,
    table: 'registries',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'list() es el catálogo compartido de registries, público por diseño y ya redactado: ' +
      'devuelve `RegistryPublic[]`, sin `auth.value` (docblock :218-224).',
  },
  {
    // ⚠️ 211 → 264 el 2026-08-26 (WKH-366 fix-pack), mismo desplazamiento que la
    // de arriba y por la misma causa. La cadena no cambió.
    file: 'src/services/registry.ts',
    line: 264,
    table: 'registries',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'getWithSecrets(id) es lectura INTERNA del mismo catálogo compartido, para armar los headers ' +
      'de un fetch outbound. El nombre hace explícito que el resultado no puede cruzar HTTP ' +
      '(docblock :254-261).',
  },
  {
    // ⚠️ 464 → 526 el 2026-08-26 (WKH-366 fix-pack): +62, y NO +53 como las dos de
    // arriba. La diferencia son las 9 líneas del guard de namespace reservado que
    // entró dentro de `register`, que vive entre medio. Por eso se midió sitio por
    // sitio y no se propagó un solo delta.
    file: 'src/services/registry.ts',
    line: 526,
    table: 'registries',
    verb: 'select',
    category: 'catalogo-publico',
    reason:
      'getEnabled() alimenta el fanout outbound de discovery/compose. Mismo catálogo compartido; ' +
      'ninguna ruta devuelve este resultado verbatim (docblock :515-523).',
  },

  // ── admin-cross-tenant (13) ─────────────────────────────────────────────
  {
    file: 'src/services/arbiter.ts',
    line: 1178,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'listHolds: su docblock :1171-1174 dice "cross-tenant DELIBERADO ... superficie de ALTO ' +
      'PRIVILEGIO gateada SÓLO por requireAdminToken". Ruta src/routes/dashboard.ts:644.',
  },
  {
    file: 'src/services/arbiter.ts',
    line: 1237,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'resolveHold: override humano admin-gated. Lee el row real para tomar `owner_ref` como dato ' +
      'autoritativo (:1233-1235). Ruta POST /api/arbitrations/:intentId/resolve, ' +
      'dashboard.ts:682-683, gate requireAdminTokenStrict en :684 (fail-closed en dev Y prod).',
  },
  {
    file: 'src/services/arbiter.ts',
    line: 1270,
    table: 'a2a_arbitrations',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'resolveHold: lectura best-effort de la evidencia del hold (ambiguity_reason/llm_reasoning) ' +
      'para preservarla. Misma ruta y mismo gate que la anterior: dashboard.ts:682-684, ' +
      'requireAdminTokenStrict. NO confundir con dashboard.ts:797, que es ' +
      'POST /api/reconciliation/:intentId/resolve y llama a reconciliationService.resolveIntent.',
  },
  {
    file: 'src/services/event.ts',
    line: 120,
    table: 'registries',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'stats(): contador global del panel (`count: exact, head: true`, no trae filas). Ruta ' +
      'dashboard.ts:591, gate requireAdminToken: 503 en producción si DASHBOARD_ADMIN_TOKEN no ' +
      'está configurado, passthrough sólo en dev.',
  },
  {
    file: 'src/services/event.ts',
    line: 128,
    table: 'tasks',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'stats(): agregado de tasks por status. Selecciona ÚNICAMENTE la columna `status`, sin ids ' +
      'ni contenido. Mismo gate admin que la anterior.',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 640,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'readLeasedRow(intentId): el intent lo elige el operador del panel. Rutas dashboard.ts:847 ' +
      'y :909, gate requireAdminTokenStrict (fail-closed en dev Y prod).',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 690,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'listPending: docblock :680-682 — "Cross-tenant DELIBERADO (patrón listHolds): sin filtro ' +
      'owner_ref, superficie de ALTO PRIVILEGIO gateada por requireAdminToken en la ruta".',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 731,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'listAmbiguous: docblock :725-727 — "Cross-tenant DELIBERADO (mismo patrón y misma ' +
      'justificación que listPending)". Ruta dashboard.ts:765.',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 1072,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'resolveIntent(intentId): el intent lo elige el operador del panel. Ruta dashboard.ts:797, ' +
      'gate requireAdminTokenStrict.',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 1535,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'driftCheck: reporte global del drift entre el débito off-chain y el balance on-chain, por ' +
      'key. Sólo reporta, nunca corrige (docblock :1527-1528). Ruta dashboard.ts:765.',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 973,
    table: 'a2a_suspended_runs',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'listSuspendedRuns: la CUARTA lista de `listAmbiguous`, y el mismo patrón que ' +
      'listSettleUnknown/listPending/listAmbiguous — superficie de ALTO PRIVILEGIO gateada por ' +
      'requireAdminToken en la ruta (dashboard.ts, GET /dashboard/api/reconciliation). El ' +
      'operador necesita ver los runs esperando de TODOS los owners; un filtro por dueño ' +
      'vaciaría el reporte, porque no hay un caller cuyo owner_ref usar. El ÚNICO otro sitio ' +
      'que toca esta tabla desde un caller autenticado SÍ filtra por dueño: ' +
      'suspendedRunService.expire (src/services/suspended-run.ts) cruza token_hash con ' +
      'owner_ref y con status, medido por src/services/suspended-run.ownership.test.ts. ' +
      'El select no trae `token_hash`: el panel no necesita el material de una credencial ajena.',
  },
  {
    file: 'src/services/trace.ts',
    line: 403,
    table: 'a2a_receipts',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'lastCrossChainSettle: indicador de vida del rail cross-chain. Ruta dashboard.ts:440, gate ' +
      'requireAdminTokenForTrace, que es fail-closed en dev Y prod porque el payload trae ' +
      'owner_ref, montos y tx hashes de TODOS los owners (docblock dashboard.ts:307-316).',
  },
  {
    file: 'src/services/trace.ts',
    line: 523,
    table: 'a2a_receipts',
    verb: 'select',
    category: 'admin-cross-tenant',
    reason:
      'recentCalls: traza operativa global de las últimas llamadas. Mismo gate fail-closed que ' +
      'lastCrossChainSettle.',
  },

  // ── worker-sin-caller (6) ───────────────────────────────────────────────
  {
    file: 'src/services/payment-intent.ts',
    line: 1635,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'worker-sin-caller',
    reason:
      'expireStale (cron), intents `open` vencidos. Docblock :1625-1629: "Barrido de sistema ' +
      '(cron): el owner guard usa el owner_ref de la propia fila — NO es IDOR". No hay request ' +
      'del cual sacar un dueño.',
  },
  {
    file: 'src/services/payment-intent.ts',
    line: 1653,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'worker-sin-caller',
    reason:
      'expireStale: intents `closing` huérfanos (finalize falló tras conocerse el veredicto). ' +
      'Mismo barrido sin caller; el owner_ref se lee de cada fila para reprocesarla.',
  },
  {
    file: 'src/services/payment-intent.ts',
    line: 1667,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'worker-sin-caller',
    reason:
      'expireStale: intents `arb_closing` huérfanos (el árbitro settleó pero finalize blipeó). ' +
      'Mismo barrido sin caller.',
  },
  {
    file: 'src/services/payment-intent.ts',
    line: 1682,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'worker-sin-caller',
    reason:
      'expireStale: intents `disputed` huérfanos, para desbrickearlos a `open`. Mismo barrido sin ' +
      'caller.',
  },
  {
    file: 'src/services/refund-outbox.ts',
    line: 223,
    table: 'a2a_refund_outbox',
    verb: 'update',
    category: 'worker-sin-caller',
    reason:
      'markDone(id): el worker del outbox marca aplicado el entry que él mismo tomó de la cola. ' +
      'El `id` no viene de ningún request. La no-reprocesabilidad la da el status, no el dueño.',
  },
  {
    file: 'src/services/refund-outbox.ts',
    line: 259,
    table: 'a2a_refund_outbox',
    verb: 'update',
    category: 'worker-sin-caller',
    reason:
      'bumpAttempt(row): el worker reencola o sepulta la fila que ya tiene en la mano. El row ' +
      'llegó del propio barrido, no de un caller.',
  },

  // ── ligadura-de-fila (2) ────────────────────────────────────────────────
  {
    file: 'src/services/receipt.ts',
    line: 192,
    table: 'a2a_receipts',
    verb: 'update',
    category: 'ligadura-de-fila',
    reason:
      'UPDATE-once del `receipt_hash` sobre la fila RECIÉN INSERTADA por este mismo proceso ' +
      '(`.eq("id", inserted.id)`), con compare-and-set `.eq("receipt_hash", "")`. El id no lo ' +
      'eligió nadie: lo devolvió el INSERT de la línea de arriba.',
  },
  {
    file: 'src/services/reconciliation.ts',
    line: 1315,
    table: 'a2a_payment_intent_debit_signatures',
    verb: 'update',
    category: 'ligadura-de-fila',
    reason:
      'Lease de evidencia del hop 2: compare-and-set sobre (key_id, debit_nonce, ' +
      'debit_settle_status="resolving_settle"), los tres derivados de la fila que el proceso ya ' +
      'leyó y claimeó. Es la guarda anti-doble-pago (docblock :1309-1312).',
  },

  // ── chequeo-en-js (3) ───────────────────────────────────────────────────
  {
    file: 'src/services/agent.ts',
    line: 347,
    table: 'a2a_agents',
    verb: 'select',
    category: 'chequeo-en-js',
    reason:
      'getRow(slug) es un pre-fetch deliberadamente SIN filtro, para poder distinguir "no existe" ' +
      'de "no es tuyo". El dueño se compara en JS en :633 (update) y :808 (delete), que lanzan ' +
      'OwnershipMismatchError. En :447 se usa como pre-check de colisión de slug, donde no hay ' +
      'dueño que comparar. El filtro de la ESCRITURA que viene después sí existe y lo prueba ' +
      'src/services/agent.ownership.test.ts (AG-02).',
  },
  {
    file: 'src/services/arbiter.ts',
    line: 594,
    table: 'a2a_payment_intents',
    verb: 'select',
    category: 'chequeo-en-js',
    reason:
      'El comentario :591-592 lo dice: "Owner-check en app (no owner-guarded SELECT) para ' +
      'preservar OWNERSHIP_MISMATCH vs INTENT_NOT_FOUND". El chequeo real está en :606-608. ' +
      'Ponerle el filtro colapsaría 403 y 404 en uno solo: sería una regresión de comportamiento.',
  },
  {
    file: 'src/services/fee-split.ts',
    line: 645,
    table: 'a2a_fee_splits',
    verb: 'select',
    category: 'chequeo-en-js',
    reason:
      'reverseFeeSplits lee TODAS las patas de la orquestación y filtra por dueño en JS en :676 ' +
      '(`rows.filter(r => r.owner_ref === ownerRef)`), devolviendo `ownership_mismatch` si ninguna ' +
      'es del caller. El UPDATE que sigue (:697) SÍ lleva `.eq("owner_ref", ownerRef)`. Sitio de ' +
      'WKH-SEC-04: se anota, no se toca acá.',
  },

  // ── unicidad-global (1) ─────────────────────────────────────────────────
  {
    file: 'src/services/identity.ts',
    line: 330,
    table: 'a2a_agent_keys',
    verb: 'select',
    category: 'unicidad-global',
    reason:
      'bindErc8004Identity pregunta si existe OTRA key activa, de cualquier dueño, con el mismo ' +
      'token_id + chain. Un pre-chequeo de unicidad acotado por dueño no sería un pre-chequeo de ' +
      'unicidad: dejaría entrar el duplicado del vecino. Selecciona sólo `id` (comentario :331: ' +
      '"SOLO id — NUNCA budget/funding_wallet").',
  },
];
