/**
 * WKH-315 — FUZZ del verificador de depósitos: la red que respalda la garantía.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ── QUE MIDE ESTE ARCHIVO, Y QUE NO (fix-pack it6 · BLQ-1) ────────────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ LA VERSION ANTERIOR DE ESTE FUZZ MEDIA **UN** GUARD Y SU PROSA NOMBRABA CUATRO.
 *
 * El barrido decía respaldar "ninguna incoherencia de PRESENCIA, DUPLICACION,
 * ILEGIBILIDAD o IDENTIDAD puede inflar el crédito", y era sensible sólo a la ecuación
 * de conservación: neutralizando cualquiera de los otros guards, seguía **verde**. Y no
 * por azar, sino por construcción del barrido:
 *   · el dataset base nunca tenía dos índices resolviendo a la MISMA dirección con
 *     filas en los dos, así que la colisión no ocurría nunca;
 *   · el alfabeto de montos sólo tenía enteros legibles ⇒ la clase ILEGIBILIDAD no se
 *     barría jamás;
 *   · las incoherencias que exigen DOS cambios del mismo lado (el caso CE1) no eran
 *     alcanzables, porque el cruce combinaba `pre` de una mutación con `post` de otra;
 *   · y los montos no salían de los saldos de las otras filas, así que la ecuación
 *     nunca podía cerrar con un `delta` inflado: "cero inflaciones" estaba garantizado
 *     casi por construcción.
 * Un fuzz que no puede ponerse rojo no es evidencia: es decoración con números.
 *
 * Este archivo tiene ahora DOS partes, y cada una dice qué prueba:
 *
 *  1. **CASOS ADVERSARIOS POR GUARD** (`describe` "candado"). Uno por clase, construido
 *     para que **la ecuación de conservación CIERRE** y por lo tanto el único que puede
 *     rechazarlo sea el guard de esa clase. Cada uno afirma el veredicto **y el needle
 *     del guard que tiene que hablar**, así que **neutralizar cualquiera de los guards
 *     pone rojo a ESTE archivo**, no sólo a la suite de tests con nombre. Ese es el
 *     candado que el revisor pidió, y es un test, no una promesa.
 *
 *  2. **BARRIDO**: mutaciones sistemáticas de una y de dos filas sobre un depósito
 *     legítimo, incluyendo montos ILEGIBLES, inyección de filas en un índice que resuelve
 *     a la dirección de NUESTRA ATA, y familias COMPENSADAS cuyos montos se derivan de
 *     los saldos de las otras filas para que la ecuación pueda cerrar con un `delta`
 *     inflado. Mide **una sola** propiedad: que ninguna combinación acredite MAS que el
 *     depósito real.
 *
 * ⚠️ SIN NUMEROS EN LA PROSA, A PROPOSITO (fix-pack it6 · BLQ-2). La versión anterior
 * citaba "206 mutaciones y 21.321 pares" en los comentarios del verificador mientras el
 * test commiteado corría 103 y 5.253: un sobre-anuncio de 2× y 4× sobre la evidencia, en
 * la prosa que gobierna un guard de dinero. Un número escrito en prosa se desactualiza
 * en silencio; el que assertea un test, no. Los conteos viven abajo, en `expect`.
 *
 * ── SENSIBILIDAD MEDIDA, no supuesta ──────────────────────────────────────────
 *
 * Cada guard se neutralizó por separado y se corrió **sólo este archivo**. Los ocho lo
 * ponen ROJO — que es el criterio que había que cumplir. Pero **cómo** lo ponen rojo no
 * es lo mismo en todos, y decirlo importa:
 *
 *   guard neutralizado                       fuzz    rojo por
 *   ─────────────────────────────────────    ─────   ────────────────────
 *   ILEGIBILIDAD                             ROJO    candado
 *   DUPLICACION (gana la última)             ROJO    candado + INFLACION
 *   DUPLICACION (gana la primera)            ROJO    candado + INFLACION
 *   IDENTIDAD (tabla por accountIndex)       ROJO    candado
 *   IDENTIDAD (owner contradictorio)         ROJO    candado
 *   PRESENCIA (eliminada)                    ROJO    candado + INFLACION
 *   PRESENCIA (sólo nuestra fila = bug it4)  ROJO    candado
 *   CONSERVACION (la ecuación)               ROJO    candado + INFLACION
 *
 * "INFLACION" = el BARRIDO encontró un dataset incoherente que acredita de más.
 * "candado"   = lo caza el caso adversario por su needle, pero el barrido NO produce
 *               una inflación con ese guard caído.
 *
 * ⚠️ Y LAS CUATRO FILAS DE SOLO-CANDADO NO TIENEN TODAS EL MISMO MOTIVO. La versión
 * anterior de esta cabecera las explicaba a las cuatro con "los guards son redundantes
 * entre sí", que es exacto para dos y flojo para las otras dos:
 *
 *  · ILEGIBILIDAD y PRESENCIA-sólo-nuestra ⇒ **otro guard toma el relevo**. Medido con
 *    un doble mutante: neutralizando además el chequeo defensivo del bloque de
 *    atribución, la familia del fantasma **sí infla**. O sea que el barrido no las aísla
 *    porque el código las cubre por partida doble — defensa en profundidad real.
 *  · IDENTIDAD (por índice) e IDENTIDAD (owner) ⇒ **no son guards anti-inflación**. El
 *    primero sigue midiendo el mismo delta sobre los datasets del barrido; el segundo no
 *    entra en ninguna aritmética de monto. Quitarlos empeora el VEREDICTO, no el número.
 *  · Y para el del `owner` hay además un límite del ORACULO, escrito abajo en
 *    `isCoherent`: el barrido es **estructuralmente ciego** a esa clase.
 *
 * La conclusión operativa no cambia —el barrido, que sólo mide INFLACION, no puede
 * aislar a esos cuatro, y para eso está el candado, que mide QUE GUARD HABLA— pero el
 * porqué ahora es el que se midió, no el primero que sonó razonable.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = vi.hoisted(() => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const st = vi.hoisted(() => vi.fn());
const gtx = vi.hoisted(() => vi.fn());
vi.mock('./chain.js', () => ({
  getSolanaConnection: () => ({
    getSignatureStatuses: st,
    getParsedTransaction: gtx,
  }),
  getSolanaUsdcMint: () => MINT,
  getSolanaUsdcDecimals: () => 6,
}));

import { verifySolanaDeposit } from './deposit-verifier.js';

const OWNER = Keypair.generate().publicKey.toBase58();
const DEP = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const OUR = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(OWNER),
).toBase58();
const DEPATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(DEP),
).toBase58();
const THIRD = Keypair.generate().publicKey.toBase58();

interface Row {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}
const row = (i: number, o: string | undefined, a: string): Row => {
  const b = {
    accountIndex: i,
    mint: MINT,
    uiTokenAmount: { amount: a, decimals: 6, uiAmount: 0, uiAmountString: a },
  };
  return o === undefined ? b : { ...b, owner: o };
};

/** El depósito REAL del dataset base: 1 USDC. La tesorería ya tenía 1000. */
const REAL = 1000000n;
const TREASURY_PRE = 1000000000n;
const DEP_PRE = 10000000n;

/**
 * ⚠️ `keys[4]` ES LA DIRECCION DE NUESTRA ATA, OTRA VEZ. Sin esto, ninguna mutación de
 * una fila puede producir DOS filas que resuelvan a la misma dirección, y toda la clase
 * DUPLICACION queda fuera del alcance del barrido — que era una de las cuatro fallas
 * estructurales de la versión anterior.
 */
const KEYS = [DEP, DEPATA, OUR, THIRD, OUR];

const build = (pre: Row[], post: Row[], keys: string[] = KEYS) => ({
  meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
  transaction: {
    message: {
      accountKeys: keys.map((k, i) => ({
        pubkey: new PublicKey(k),
        signer: i === 0,
        writable: true,
      })),
    },
  },
});

const base = () => ({
  pre: [row(1, DEP, String(DEP_PRE)), row(2, OWNER, String(TREASURY_PRE))],
  post: [
    row(1, DEP, String(DEP_PRE - REAL)),
    row(2, OWNER, String(TREASURY_PRE + REAL)),
  ],
});

const setTx = (tx: unknown) => gtx.mockResolvedValue(tx);
const verify = () => verifySolanaDeposit({ signature: 'sig' });

beforeEach(() => {
  process.env.A2A_DEPOSIT_OWNER_SOLANA = OWNER;
  process.env.A2A_DEPOSIT_ENABLED_SOLANA = 'true';
  st.mockResolvedValue({
    value: [
      {
        slot: 1,
        confirmations: null,
        err: null,
        confirmationStatus: 'finalized',
      },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CANDADO: un caso adversario por guard, con la ecuación CERRANDO
// ═══════════════════════════════════════════════════════════════════════════════
//
// Cada dataset de acá está construido para que `delta === baja neta de las demás`, así
// que el invariante de conservación **no lo puede rechazar**: el único que puede es el
// guard de su clase. Y cada test afirma el needle de ese guard, no sólo el veredicto —
// si el veredicto lo terminara dando otro guard, el test se pone rojo igual y el
// desafilado no puede pasar inadvertido (la lección de it2 y it3).
describe('FUZZ · candado: cada guard tiene un caso donde es EL UNICO que puede rechazar', () => {
  it('PRESENCIA (CE1): una fila fantasma sólo en `pre` financia el exceso y la ecuación CIERRA', async () => {
    const phantom = TREASURY_PRE;
    setTx(
      build(
        [
          row(1, DEP, String(DEP_PRE)),
          row(2, OWNER, String(TREASURY_PRE)),
          // El `owner` de la fila fantasma es INDISTINTO. Medido con las dos variantes
          // (`DEP` y un tercero): el veredicto es idéntico carácter por carácter, y con
          // la presencia bilateral neutralizada el conjunto de inflaciones del barrido
          // también. La razón está en el propio verificador: **la presencia bilateral
          // corre ANTES del bloque de atribución**, así que el fantasma nunca llega a
          // ser un segundo origen.
          //
          // ⚠️ ESTE COMENTARIO DECIA OTRA COSA, Y ESTABA PREFIJADO CON "Medido:".
          // Afirmaba que con otro owner el veredicto lo daba `DEPOSITOR_AMBIGUOUS` y que
          // el caso dejaba de aislar la PRESENCIA. Las dos cosas son FALSAS y ninguna se
          // midió. En el archivo cuya única razón de existir es que su prosa coincida
          // con lo que mide, y con la palabra que más confianza transmite adelante: el
          // próximo revisor deja de buscar acá por una razón inventada.
          row(3, DEP, String(phantom)),
        ],
        [
          row(1, DEP, String(DEP_PRE - REAL)),
          row(2, OWNER, String(TREASURY_PRE + REAL + phantom)),
        ],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('appears in only ONE');
  });

  it('PRESENCIA (truncada): sin la fila `pre` de nuestra ATA y con el origen compensado, la ecuación CIERRA', async () => {
    const infl = TREASURY_PRE + REAL;
    setTx(
      build(
        [row(1, DEP, String(DEP_PRE + infl))],
        [row(1, DEP, String(DEP_PRE - REAL)), row(2, OWNER, String(infl))],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('appears in only ONE');
  });

  it('DUPLICACION: dos índices con la MISMA dirección, `owner` COHERENTE y la ecuación cerrando', async () => {
    // ⚠️ `owner` coherente en las dos filas A PROPOSITO: así el guard de contradicción
    // no puede hablar y el único que queda es el duplicado por dirección.
    const infl = TREASURY_PRE + REAL;
    setTx(
      build(
        [
          row(1, DEP, String(DEP_PRE + infl)),
          row(2, OWNER, '0'),
          row(4, OWNER, String(TREASURY_PRE)),
        ],
        [
          row(1, DEP, String(DEP_PRE - REAL)),
          row(2, OWNER, String(infl)),
          row(4, OWNER, '0'),
        ],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('TWO entries for the same account');
  });

  it('IDENTIDAD: la fila de nuestra dirección con el `owner` MENTIDO, sin ninguna otra incoherencia', async () => {
    setTx(
      build(
        [row(1, DEP, String(DEP_PRE)), row(2, OTHER, String(TREASURY_PRE))],
        [
          row(1, DEP, String(DEP_PRE - REAL)),
          row(2, OTHER, String(TREASURY_PRE + REAL)),
        ],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('the dataset contradicts itself');
  });

  it('ILEGIBILIDAD: el `amount` de nuestra fila `pre` no es un entero, con el origen compensado', async () => {
    const infl = TREASURY_PRE + REAL;
    setTx(
      build(
        [row(1, DEP, String(DEP_PRE + infl)), row(2, OWNER, '1.0')],
        [row(1, DEP, String(DEP_PRE - REAL)), row(2, OWNER, String(infl))],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('unreadable uiTokenAmount.amount');
  });

  it('CONSERVACION: listas completas, legibles y sin duplicados, pero los números no cuadran', async () => {
    setTx(
      build(
        [row(1, DEP, String(DEP_PRE)), row(2, OWNER, String(TREASURY_PRE))],
        [
          row(1, DEP, String(DEP_PRE)),
          row(2, OWNER, String(TREASURY_PRE + REAL)),
        ],
      ),
    );
    const res = await verify();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`acreditó ${res.amountUsd}`);
    expect(res.detail).toContain('conservation check failed');
  });

  it('ANDAMIAJE: el dataset base —sin ninguna incoherencia— acredita EXACTAMENTE el depósito real', async () => {
    const b = base();
    setTx(build(b.pre, b.post));
    const res = await verify();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.amountAtomic).toBe(REAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. BARRIDO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Alfabeto de montos: incluye **ilegibles** (la clase que el barrido anterior no tocaba
 * nunca) y valores **derivados de los saldos de las otras filas**, que son los únicos con
 * los que la ecuación puede cerrar sobre un `delta` inflado.
 */
const AMOUNTS = [
  '0',
  '1',
  String(REAL),
  String(TREASURY_PRE),
  String(TREASURY_PRE + REAL),
  String(DEP_PRE + TREASURY_PRE),
  '1.0',
  '1e9',
  '',
  '   ',
  '+5',
  '0x10',
  'abc',
];
const OWNERS: (string | undefined)[] = [OWNER, DEP, OTHER, undefined];
/** Incluye el 4, que resuelve a la dirección de NUESTRA ATA. */
const INDEXES = [0, 1, 2, 3, 4];

interface Case {
  label: string;
  pre: Row[];
  post: Row[];
  keys: string[];
}

function singles(): Case[] {
  const out: Case[] = [];
  for (const side of ['pre', 'post'] as const) {
    for (let i = 0; i < 2; i++) {
      const mk = (label: string, f: (rows: Row[]) => Row[]) => {
        const b = base();
        const rows = f(b[side].map((r) => ({ ...r })));
        out.push({
          label: `${side}[${i}] ${label}`,
          pre: side === 'pre' ? rows : b.pre,
          post: side === 'post' ? rows : b.post,
          keys: KEYS,
        });
      };
      mk('borrada', (r) => r.filter((_, j) => j !== i));
      mk('duplicada', (r) => [...r, { ...(r[i] as Row) }]);
      for (const a of AMOUNTS) {
        mk(`amount=${a}`, (r) => {
          const c = [...r];
          const o = r[i] as Row;
          c[i] = { ...o, uiTokenAmount: { ...o.uiTokenAmount, amount: a } };
          return c;
        });
      }
      for (const o of OWNERS) {
        mk(`owner=${o?.slice(0, 6) ?? 'ausente'}`, (r) => {
          const c = [...r];
          const cur = r[i] as Row;
          if (o === undefined) {
            const { owner: _drop, ...rest } = cur;
            c[i] = rest as Row;
          } else {
            c[i] = { ...cur, owner: o };
          }
          return c;
        });
      }
      mk('mint=otro', (r) => {
        const c = [...r];
        c[i] = { ...(r[i] as Row), mint: THIRD };
        return c;
      });
      for (const idx of INDEXES) {
        mk(`accountIndex=${idx}`, (r) => {
          const c = [...r];
          c[i] = { ...(r[i] as Row), accountIndex: idx };
          return c;
        });
      }
      for (const idx of INDEXES) {
        for (const a of AMOUNTS) {
          mk(`+fila idx=${idx} amount=${a}`, (r) => [...r, row(idx, OTHER, a)]);
        }
      }
    }
  }
  for (const keys of [
    [DEP, DEPATA, OUR, OUR, OUR],
    [DEP, DEPATA],
    [DEP, DEPATA, THIRD, THIRD, THIRD],
  ]) {
    const b = base();
    out.push({
      label: `keys=${keys.length} slots`,
      pre: b.pre,
      post: b.post,
      keys,
    });
  }
  return out;
}

/**
 * Familias COMPENSADAS: dos cambios del MISMO lado con los montos derivados de los otros
 * saldos, para que la ecuación cierre sobre un `delta` inflado. Es la forma de CE1 y de
 * la truncación de nuestra fila, parametrizada — exactamente lo que el barrido anterior
 * no podía alcanzar.
 */
function compensated(): Case[] {
  const out: Case[] = [];
  for (const A of [REAL, TREASURY_PRE, TREASURY_PRE + REAL, DEP_PRE]) {
    out.push({
      label: `compensada: fantasma pre A=${A}`,
      pre: [
        row(1, DEP, String(DEP_PRE)),
        row(2, OWNER, String(TREASURY_PRE)),
        row(3, DEP, String(A)), // mismo owner: ver el comentario del candado CE1
      ],
      post: [
        row(1, DEP, String(DEP_PRE - REAL)),
        row(2, OWNER, String(TREASURY_PRE + REAL + A)),
      ],
      keys: KEYS,
    });
    out.push({
      label: `compensada: nuestra pre ausente A=${A}`,
      pre: [row(1, DEP, String(DEP_PRE + A))],
      post: [
        row(1, DEP, String(DEP_PRE - REAL)),
        row(2, OWNER, String(A + REAL)),
      ],
      keys: KEYS,
    });
    for (const swap of [false, true]) {
      const ours = [row(2, OWNER, '0'), row(4, OWNER, String(A))];
      const oursPost = [row(2, OWNER, String(A + REAL)), row(4, OWNER, '0')];
      out.push({
        label: `compensada: dos indices misma direccion A=${A} swap=${swap}`,
        pre: [
          row(1, DEP, String(DEP_PRE + REAL)),
          ...(swap ? [...ours].reverse() : ours),
        ],
        post: [
          row(1, DEP, String(DEP_PRE - REAL)),
          ...(swap ? [...oursPost].reverse() : oursPost),
        ],
        keys: KEYS,
      });
    }
    out.push({
      label: `compensada: nuestra pre ilegible A=${A}`,
      pre: [row(1, DEP, String(DEP_PRE + A)), row(2, OWNER, '1.0')],
      post: [
        row(1, DEP, String(DEP_PRE - REAL)),
        row(2, OWNER, String(A + REAL)),
      ],
      keys: KEYS,
    });
    out.push({
      label: `compensada: owner mentido A=${A}`,
      pre: [row(1, DEP, String(DEP_PRE)), row(2, OTHER, String(TREASURY_PRE))],
      post: [
        row(1, DEP, String(DEP_PRE - REAL)),
        row(2, OTHER, String(TREASURY_PRE + REAL)),
      ],
      keys: KEYS,
    });
  }
  return out;
}

/**
 * ¿El dataset es INTERNAMENTE COHERENTE? Escrito desde la ESPECIFICACION, no copiado
 * del verificador: toda dirección del mint aparece en las dos listas, ninguna dos veces,
 * todos los montos son enteros decimales, y lo que subió es lo que bajó.
 *
 * ⚠️ POR QUE ESTE PREDICADO EXISTE, Y ES EL HALLAZGO DE ESTA RONDA. El barrido cruza el
 * `pre` de un caso con el `post` de otro, y esa combinación **no siempre es una
 * corrupción de un depósito de 1 USDC: a veces es un dataset COHERENTE que describe un
 * depósito legítimo más grande**. El primer barrido ampliado marcó justamente uno
 * (`pre` del depositante con 1010 USDC cruzado con un `post` de 2001) y **acreditar
 * 1001 ahí es CORRECTO**: las dos listas cuadran y dicen que alguien pagó 1001.
 *
 * O sea que "acreditó más que el depósito base" NO es, por sí solo, la definición de
 * inflación para datasets arbitrarios. Es el mismo límite que el verificador ya declara:
 * una historia consistente pero falsa es indistinguible de la verdad por cualquier
 * chequeo local. El oráculo honesto es entonces: **sobre un dataset INCOHERENTE, el
 * crédito nunca puede superar el depósito real**.
 *
 * ⚠️ PUNTO CIEGO DECLARADO DE ESTE ORACULO: **no modela la clase IDENTIDAD**. No lee
 * `owner` en ninguna línea, así que un dataset con el `owner` de nuestra ATA MENTIDO lo
 * clasifica como COHERENTE mientras el verificador lo rechaza por contradicción —
 * medido. Consecuencia: el BARRIDO es estructuralmente ciego a esa clase y su cobertura
 * la aporta el candado, no el barrido. Se escribe acá para que el próximo no lo
 * descubra creyendo que encontró un agujero del verificador.
 */
function isCoherent(pre: Row[], post: Row[], keys: string[]): boolean {
  const addr = (i: number) => keys[i];
  const table = (rows: Row[]): Map<string, bigint> | null => {
    const m = new Map<string, bigint>();
    for (const r of rows) {
      if (r.mint !== MINT) continue;
      const a = addr(r.accountIndex);
      if (a === undefined) return null; // índice sin clave: irresoluble
      if (m.has(a)) return null; // duplicado
      if (!/^\d+$/.test(r.uiTokenAmount.amount)) return null; // ilegible
      m.set(a, BigInt(r.uiTokenAmount.amount));
    }
    return m;
  };
  const p = table(pre);
  const q = table(post);
  if (p === null || q === null) return false;
  const all = new Set([...p.keys(), ...q.keys()]);
  let up = 0n;
  let down = 0n;
  for (const a of all) {
    if (p.has(a) !== q.has(a)) return false; // presencia asimétrica
    const b = p.get(a) ?? 0n;
    const c = q.get(a) ?? 0n;
    if (c > b) up += c - b;
    else down += b - c;
  }
  return up === down;
}

describe('FUZZ · barrido: sobre un dataset INCOHERENTE nunca se acredita de más', () => {
  const ALL = [...singles(), ...compensated()];

  it('andamiaje: el barrido no se encogió', () => {
    // Si alguien saca un monto, un owner o un índice del alfabeto, esto se pone rojo.
    // Un barrido que se achica en silencio es la forma más barata de perder la red.
    expect(AMOUNTS.length).toBe(13);
    expect(OWNERS.length).toBe(4);
    expect(INDEXES.length).toBe(5);
    expect(ALL.length).toBe(387);
  });

  it('UNA mutación: cero inflaciones', async () => {
    const bad: string[] = [];
    let incoherentes = 0;
    for (const c of ALL) {
      const coherente = isCoherent(c.pre, c.post, c.keys);
      if (!coherente) incoherentes++;
      setTx(build(c.pre, c.post, c.keys));
      const res = await verify();
      if (!coherente && res.ok && res.amountAtomic > REAL) {
        bad.push(`${c.label} ⇒ ${res.amountAtomic}`);
      }
    }
    // Andamiaje: si el barrido dejara de producir datasets incoherentes, el oráculo no
    // estaría mirando nada. La mayoría de las mutaciones TIENE que romper la coherencia.
    expect(incoherentes).toBeGreaterThan(ALL.length / 2);
    expect(bad, `${bad.length} inflaciones:\n${bad.join('\n')}`).toEqual([]);
    // ⚠️ TIMEOUT EXPLICITO. Este barrido corre miles de verificaciones; con el default de
    // 5s y la suite entera en paralelo se pasa por carga, no por lentitud propia, y un
    // net que flakea deja de ser un net (se observó una vez, corriendo el directorio).
  }, 60_000);

  it('DOS mutaciones cruzadas (`pre` de una, `post` de otra): cero inflaciones', async () => {
    // ⚠️ EL CRUCE ES DENSO DONDE IMPORTA Y MUESTREADO DONDE NO, y el criterio está
    // escrito para que se pueda discutir: **todos** los pares que involucran una familia
    // COMPENSADA (las adversarias, las únicas construidas para que la ecuación cierre
    // sobre un delta inflado) y un muestreo DETERMINISTICO por paso fijo del resto. El
    // producto completo son ~75k verificaciones y ~17s: triplicar el tiempo de la suite
    // entera para re-barrer combinaciones que el barrido de UNA mutación ya cubre no es
    // una compra buena. El muestreo es por índice, no aleatorio: dos corridas dan
    // exactamente el mismo conjunto, así que un rojo es reproducible.
    const STRIDE = 13;
    const bad: string[] = [];
    let n = 0;
    let coherentes = 0;
    let densos = 0;
    for (let i = 0; i < ALL.length; i++) {
      for (let j = i + 1; j < ALL.length; j++) {
        const a = ALL[i] as Case;
        const b = ALL[j] as Case;
        const adversario =
          a.label.startsWith('compensada') || b.label.startsWith('compensada');
        if (adversario) densos++;
        else if ((i * ALL.length + j) % STRIDE !== 0) continue;
        n++;
        const coherente = isCoherent(a.pre, b.post, b.keys);
        if (coherente) coherentes++;
        setTx(build(a.pre, b.post, b.keys));
        const res = await verify();
        if (!coherente && res.ok && res.amountAtomic > REAL) {
          bad.push(`${a.label} × ${b.label} ⇒ ${res.amountAtomic}`);
        }
      }
    }
    // Andamiaje del muestreo: la parte DENSA tiene que ser la mayoría de lo corrido, y
    // el total, una fracción grande del producto completo. Si alguien sube el paso, esto
    // se pone rojo antes de que la red se afine en silencio.
    const total = (ALL.length * (ALL.length - 1)) / 2;
    expect(densos).toBeGreaterThan(total / 10); // >10% denso (los adversarios)
    expect(n).toBeGreaterThan((total * 15) / 100); // >15% del producto completo
    // Andamiaje del oráculo: los cruces coherentes existen y son POCOS. Si fueran la
    // mayoría, el filtro estaría tapando el barrido en vez de acotarlo.
    expect(coherentes).toBeGreaterThan(0);
    expect(coherentes).toBeLessThan(n / 10);
    expect(
      bad,
      `${bad.length} inflaciones sobre ${n} pares:\n${bad.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  }, 120_000);
});
