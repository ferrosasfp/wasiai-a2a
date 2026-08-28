/**
 * Published Agent Service — el booleano de completitud de la fila (WKH-370).
 *
 * La tesis de la HU: una fila MAL NACIDA se ve exactamente igual que una sana
 * desde el catálogo público. Las dos filas self-published sin billetera de cobro
 * coincidían con su manifiesto vivo en los cinco campos comparables — deriva CERO —
 * y estaban rotas igual. La única forma de verlas desde afuera es que el shape del
 * DUEÑO lo diga, y eso es lo que este archivo fija.
 *
 * T-B1 — el booleano distingue `null`, cadena de espacios y valor real.
 * T-B2 — CONTROL NEGATIVO: el objeto del catálogo ANÓNIMO no lo lleva, ni lleva la
 *        columna. La HU no agrega superficie pública anónima.
 * T-S5 — ningún comentario que esta HU agrega o edita en `agent.ts` cita una línea.
 * T-S6 — y la prosa que sobrevivió a esa edición es VERDADERA, no sólo distinta: los
 *        números y el sujeto de cada afirmación se DERIVAN del fuente.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { listData: [] as Record<string, unknown>[] },
}));

// `listMine` y `listAsAgents` resuelven en `.order(...)`; no se ejercita ninguna
// escritura acá, así que el doble no necesita `insert`/`update`/`single`.
vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: state.listData, error: null }),
  });
  return { supabase: { from: () => builder } };
});

import { publishedAgentService } from './agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = readFileSync(resolve(HERE, 'agent.ts'), 'utf8');

const fila = (payoutWallet: string | null) => ({
  slug: 'remit-corridor-fx-solana',
  name: 'remit-corridor-fx-solana',
  description: 'Cotiza el corredor',
  capabilities: ['remittance-fx-quote'],
  agent_url: 'https://agentes.example/api/agents/remit-corridor-fx/invoke',
  price_usdc: 0.03,
  metadata: { inputSchema: { type: 'object' } },
  enabled: true,
  owner_ref: 'owner-1',
  created_at: '2026-08-27T00:00:00.000Z',
  payout_wallet: payoutWallet,
});

describe('WKH-370 · hasPayoutWallet en el shape del dueño', () => {
  beforeEach(() => {
    state.listData = [];
  });

  it('T-B1: false con null Y con una cadena de espacios; true con un valor', async () => {
    state.listData = [
      { ...fila(null), slug: 'sin-billetera' },
      { ...fila('   '), slug: 'con-espacios' },
      {
        ...fila('So11111111111111111111111111111111111111112'),
        slug: 'con-billetera',
      },
    ];
    const registros = await publishedAgentService.listMine('owner-1');
    const porSlug = new Map(registros.map((r) => [r.slug, r]));

    expect(porSlug.get('sin-billetera')?.hasPayoutWallet).toBe(false);
    // La cadena de espacios es el caso que mata al mutante `!!row.payout_wallet`:
    // con esa implementación la fila cuenta como completa, y es justo la clase de
    // fila mal nacida que el chequeo existe para delatar.
    expect(porSlug.get('con-espacios')?.hasPayoutWallet).toBe(false);
    expect(porSlug.get('con-billetera')?.hasPayoutWallet).toBe(true);

    // Y es SIEMPRE un booleano, nunca ausente: "no la tiene" y "el campo no viajó"
    // tienen que poder distinguirse del otro lado.
    for (const r of registros) expect(typeof r.hasPayoutWallet).toBe('boolean');
  });

  it('T-B2 (CONTROL NEGATIVO): el objeto del catálogo anónimo NO lleva el booleano ni la columna', async () => {
    // El repo es público y `/discover` no pide credencial: si el booleano se
    // colara al mapper equivocado, la presencia de billetera de cada agente
    // quedaría publicada a todo el mundo. La barrera de tipo la da el parámetro de
    // ese mapper, que sigue sin declarar la columna; ésta es la barrera de valor.
    state.listData = [fila('So11111111111111111111111111111111111111112')];
    const agentes = await publishedAgentService.listAsAgents();

    expect(agentes).toHaveLength(1);
    const publicado = agentes[0] as unknown as Record<string, unknown>;
    expect(publicado).not.toHaveProperty('hasPayoutWallet');
    expect(publicado).not.toHaveProperty('payout_wallet');
    expect(publicado).not.toHaveProperty('payoutWallet');
    // Ni escondido dentro del metadata que ese mapper sí emite.
    expect(JSON.stringify(publicado)).not.toContain(
      'So11111111111111111111111111111111111111112',
    );
    // Control positivo del mismo objeto: el mapper SÍ corrió y produjo el agente.
    expect(publicado.slug).toBe('remit-corridor-fx-solana');
  });

  it('T-S5: ningún comentario que esta HU agrega o edita cita una línea', () => {
    // El guardián de citas NO declara su universo: lo DERIVA en cada corrida, y una
    // de sus formas sintácticas es un `:` seguido de dígitos SIN path delante. Este
    // archivo de servicio está dentro del corte que ese guardián barre, así que un
    // número de línea en un comentario nuevo nace como cita no declarada y pone
    // `npm test` en rojo. Se nombran archivos y SÍMBOLOS, nunca líneas.
    const lineas = AGENT_SRC.split('\n');
    const esComentario = (l: string) => /^\s*(\*|\/\/|\/\*)/.test(l);
    const bloques: string[] = [];
    for (let i = 0; i < lineas.length; i += 1) {
      if (!(lineas[i] as string).includes('WKH-370')) continue;
      let inicio = i;
      let fin = i;
      while (inicio > 0 && esComentario(lineas[inicio - 1] as string))
        inicio -= 1;
      while (fin < lineas.length - 1 && esComentario(lineas[fin + 1] as string))
        fin += 1;
      bloques.push(lineas.slice(inicio, fin + 1).join('\n'));
    }
    // Control positivo: si el barrido no encontró nada, no probó nada.
    expect(bloques.length).toBeGreaterThanOrEqual(4);
    for (const bloque of bloques) expect(bloque).not.toMatch(/:\d/);

    // Y la corrección obligatoria: el párrafo que afirmaba que la columna jamás
    // entra a un shape público ya no puede quedar escrito como estaba, porque el
    // mapper del dueño ahora la lee. Lo que sigue siendo cierto se conserva.
    const desde = AGENT_SRC.indexOf('async getSplitContextRow');
    const doc = AGENT_SRC.slice(AGENT_SRC.lastIndexOf('/**', desde), desde);
    expect(doc).toContain('WKH-370 CORRIGIÓ ESTE PÁRRAFO');
    expect(doc).not.toMatch(/JAMÁS entran a `AgentRow` ni a un shape público/);
    expect(doc).toContain('el VALOR no sale a ningún lado');
  });

  it('T-S6 (CR-it1/BLQ-5): la prosa que sobrevivió es VERDADERA, no sólo distinta', () => {
    // T-S5 verifica que el párrafo se EDITÓ. Eso es presencia de la edición, nunca
    // verdad de la frase superviviente — la misma clase de guardián que mira la
    // columna y no el valor. Y la frase superviviente era falsa para una de las tres
    // columnas: decía que `AgentRow` "no las tipa", con antecedente
    // `owner_ref, payout_wallet, referrer_ref`.
    const desde = AGENT_SRC.indexOf('async getSplitContextRow');
    const doc = AGENT_SRC.slice(AGENT_SRC.lastIndexOf('/**', desde), desde);

    // El ANCLA de verdad, derivada del tipo real y no copiada del párrafo: `AgentRow`
    // SÍ declara `owner_ref`, y NO declara las otras dos. Si algún día eso cambia, el
    // párrafo tiene que cambiar con él y este test es el que lo obliga.
    const inicioTipo = AGENT_SRC.indexOf('interface AgentRow {');
    const agentRow = AGENT_SRC.slice(
      inicioTipo,
      AGENT_SRC.indexOf('\n}', inicioTipo),
    );
    expect(inicioTipo).toBeGreaterThan(-1);
    expect(agentRow).toContain('owner_ref: string;');
    expect(agentRow).not.toContain('payout_wallet');
    expect(agentRow).not.toContain('referrer_ref');
    // ⇒ para `owner_ref` la barrera del catálogo anónimo NO puede ser el tipo. Es de
    // valor: `mapRowToAgent` podría leerla y no la emite (T-B2 lo fija). El párrafo
    // tiene que decir eso, y no lo contrario.
    expect(doc).toContain('sólo para dos de las tres');
    expect(doc).toContain('no es de TIPO sino de VALOR');

    // Y el otro número que el párrafo del tipo afirma: los llamadores del mapper del
    // dueño se CUENTAN sobre el fuente, no se escriben de memoria. Eran "cuatro" en
    // dos sitios distintos, y son tres.
    const enPalabras = ['cero', 'un', 'dos', 'tres', 'cuatro', 'cinco'];
    const llamadores = AGENT_SRC.split('\n').filter(
      (l) =>
        l.includes('mapRowToRecord') &&
        !/^\s*(\*|\/\/)/.test(l) &&
        !l.includes('function mapRowToRecord'),
    );
    expect(llamadores).toHaveLength(3);
    // Acotado al docblock del tipo que esta HU agregó: `agent.ts` habla de "los dos
    // llamadores" de OTRA función más abajo, y esa frase es de otra HU y es cierta.
    const dondeTipo = AGENT_SRC.indexOf('type OwnedAgentRow =');
    const docTipo = AGENT_SRC.slice(
      AGENT_SRC.lastIndexOf('/**', dondeTipo),
      dondeTipo,
    );
    expect(dondeTipo).toBeGreaterThan(-1);
    expect(docTipo).toContain(
      `los ${enPalabras[llamadores.length]} llamadores`,
    );
    expect(docTipo).not.toMatch(/los (cero|un|dos|cuatro|cinco) llamadores/);
  });
});
