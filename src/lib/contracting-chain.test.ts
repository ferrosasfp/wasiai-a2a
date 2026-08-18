/**
 * WKH-360 W0 — la UNIDAD del módulo leaf de identidad propia y traza de
 * contratación.
 *
 * Este archivo cubre `src/lib/contracting-chain.ts` **como función pura**. Que los
 * guards estén efectivamente CABLEADOS —y, sobre todo, que corten ANTES del
 * débito— NO se prueba acá: eso vive en los tests de ORDEN de los cuatro sitios
 * (`routes/compose.contracting-loop.test.ts`,
 * `services/compose.contracting-loop.test.ts`,
 * `services/orchestrate.contracting-loop.test.ts`).
 * Un verde de este archivo NO dice nada sobre el orden respecto del dinero.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSelfHostsEnv,
  buildOutboundContractingHeaders,
  CONTRACTING_CHAIN_HEADER,
  CONTRACTING_CHAIN_MALFORMED,
  CONTRACTING_DEPTH_EXCEEDED,
  CONTRACTING_DEPTH_HEADER,
  CONTRACTING_DEPTH_MALFORMED,
  CONTRACTING_LOOP_DETECTED,
  canonicalizeHost,
  classifySelfHostsEnv,
  contractingDepthMaxWarning,
  DEFAULT_CONTRACTING_DEPTH_MAX,
  isSelfDestination,
  readContractingGuardHealth,
  readCoordinatorFee,
  readInboundContracting,
  resolveContractingDepthMax,
  resolveSelfHosts,
  rollUpCascadedFee,
} from './contracting-chain.js';

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));

const ENV_KEYS = [
  'A2A_SELF_HOSTS',
  'A2A_CONTRACTING_DEPTH_MAX',
  'BASE_URL',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Helper: el verdicto de un inbound con techo por default. */
function read(
  chain: string | string[] | undefined,
  depth: string | string[] | undefined,
  selfHosts: string[] = ['gw.example.com'],
  depthMax = DEFAULT_CONTRACTING_DEPTH_MAX,
) {
  return readInboundContracting({ chain, depth }, selfHosts, depthMax);
}

describe('canonicalizeHost — las 6 variantes de host', () => {
  it('T-U-HOST-1: baja a minúsculas (gratis, lo hace `new URL`)', () => {
    expect(canonicalizeHost('GW.EXAMPLE.COM')).toBe('gw.example.com');
  });

  it('T-U-HOST-2 (CD-15): QUITA el punto final — el paso que `canonicalizeHostKey` NO tiene', () => {
    // Medido: `new URL('https://EXAMPLE.com./x').hostname === 'example.com.'`.
    // Sin este strip, `https://<self>./compose` es un bypass de UNA tecla.
    expect(canonicalizeHost('gw.example.com.')).toBe('gw.example.com');
    expect(canonicalizeHost('GW.EXAMPLE.COM.')).toBe('gw.example.com');
  });

  it('T-U-HOST-3: convierte a punycode (IDN homógrafo)', () => {
    expect(canonicalizeHost('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
    // Las dos formas colapsan al MISMO valor, que es la propiedad que hace que
    // un destino en unicode y uno en punycode no puedan divergir.
    expect(canonicalizeHost('xn--e1afmkfd.xn--p1ai')).toBe(
      'xn--e1afmkfd.xn--p1ai',
    );
  });

  it('T-U-HOST-4: rechaza esquema, puerto, userinfo, path, query, fragment', () => {
    expect(canonicalizeHost('https://gw.example.com')).toBeNull();
    expect(canonicalizeHost('gw.example.com:8443')).toBeNull();
    expect(canonicalizeHost('user@gw.example.com')).toBeNull();
    expect(canonicalizeHost('gw.example.com/compose')).toBeNull();
  });

  /**
   * Fix-pack AR/MNR-1. Antes se rechazaban las DOS formas de IPv6, y la doc
   * invitaba a poner "un literal de IP" en `A2A_SELF_HOSTS` — donde una entrada
   * ilegible hace que **el proceso no arranque**. O sea: seguir la doc volteaba el
   * servicio.
   *
   * Se acepta SÓLO la forma con corchetes, y no por estilo: el conjunto se compara
   * contra `new URL(destino).hostname`, que para IPv6 devuelve siempre esa forma.
   * Aceptar `::1` pelado sería aceptar algo que nunca puede matchear un destino —
   * bootea y no protege, que es el peor de los dos mundos.
   */
  it('T-U-HOST-7 (AR/MNR-1): IPv6 ENTRE CORCHETES se acepta; pelado y con puerto, no', () => {
    // La forma que `new URL().hostname` produce, que es contra la que comparamos.
    expect(new URL('https://[::1]/x').hostname).toBe('[::1]');
    expect(canonicalizeHost('[::1]')).toBe('[::1]');
    expect(canonicalizeHost('[2001:db8::1]')).toBe('[2001:db8::1]');
    // El parser NORMALIZA, así que dos escrituras de la misma dirección colapsan al
    // mismo valor — la propiedad que hace que no puedan divergir.
    expect(canonicalizeHost('[::0001]')).toBe('[::1]');

    // Pelado: NO. Nunca podría matchear un destino, así que aceptarlo sería
    // dejar bootear una identidad que no protege.
    expect(canonicalizeHost('::1')).toBeNull();
    // Con puerto: NO (no termina en `]`).
    expect(canonicalizeHost('[::1]:8443')).toBeNull();
    // Basura entre corchetes: NO (el parser tira y se devuelve null sin tirar).
    expect(canonicalizeHost('[not-ipv6]')).toBeNull();
    expect(canonicalizeHost('[]')).toBeNull();
    expect(canonicalizeHost('[::1]x')).toBeNull();

    // Y el efecto que motivó el fix: con la forma correcta el arranque NO se cae.
    process.env.A2A_SELF_HOSTS = '[::1]';
    expect(() => assertSelfHostsEnv()).not.toThrow();
    expect(resolveSelfHosts().hosts).toEqual(['[::1]']);
    // …y un destino IPv6 propio se reconoce de punta a punta.
    expect(
      isSelfDestination('https://[::1]/compose', resolveSelfHosts().hosts),
    ).toBe(true);
  });

  it('T-U-HOST-5: rechaza bordes con espacios y el string vacío', () => {
    expect(canonicalizeHost(' gw.example.com')).toBeNull();
    expect(canonicalizeHost('gw.example.com ')).toBeNull();
    expect(canonicalizeHost('')).toBeNull();
  });

  it('T-U-HOST-6: un literal de IP se canonicaliza (R-3 sigue abierto por otra razón)', () => {
    // La IP literal NO es un caso cerrado: la comparación es POR NOMBRE, así que
    // `https://69.46.46.64/compose` sólo matchea si un operador puso esa IP en
    // `A2A_SELF_HOSTS`. Esto verifica ESA puerta, no que el bypass esté cerrado.
    expect(canonicalizeHost('69.46.46.64')).toBe('69.46.46.64');
  });
});

describe('readInboundContracting — paso 4: los 8 valores de profundidad (CD-14)', () => {
  it('T-U-DEPTH-1: AUSENTE ⇒ 0 (el 100% del tráfico de hoy, no una concesión)', () => {
    const v = read(undefined, undefined);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.depth).toBe(0);
  });

  it('T-U-DEPTH-2: dígitos válidos ⇒ su valor', () => {
    const v = read(undefined, '1');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.depth).toBe(1);
    // el rango completo del regex, con techo alto para no chocar el paso 6
    // (depthMax=1000, no 999: el corte es `>=`, así que con 999 el propio techo
    // rechazaría y este `it` mediría el paso 6 en vez del paso 4)
    const high = read(undefined, '999', ['gw.example.com'], 1000);
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.depth).toBe(999);
  });

  it("T-U-DEPTH-3: '1e9' ⇒ MALFORMED, y NO pasa como 1 (parseInt lo lee 1)", () => {
    // Medido: Number.parseInt('1e9', 10) === 1. Un atacante declara profundidad
    // mil millones y un lector con parseInt lo trata como el primer salto.
    expect(Number.parseInt('1e9', 10)).toBe(1);
    const v = read(undefined, '1e9');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it("T-U-DEPTH-4: '' ⇒ MALFORMED, y NO pasa como 0 (Number lo lee 0 = RESETEO)", () => {
    // Medido: Number('') === 0. Degradarlo a 0 es dejar que un tercero resetee
    // el contador de profundidad, que es el ataque, no un accidente.
    expect(Number('')).toBe(0);
    const v = read(undefined, '');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it("T-U-DEPTH-5: ' 2', '2abc', '0x10' ⇒ MALFORMED (parseInt lee 2, 2 y 0)", () => {
    expect(Number.parseInt(' 2', 10)).toBe(2);
    expect(Number.parseInt('2abc', 10)).toBe(2);
    const cases = [' 2', '2abc', '0x10'];
    expect(cases).toHaveLength(3);
    for (const raw of cases) {
      const v = read(undefined, raw);
      expect(v.ok, `depth=${JSON.stringify(raw)}`).toBe(false);
      if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
    }
  });

  it("T-U-DEPTH-6: '1000' ⇒ MALFORMED por FORMA, antes de comparar con el techo", () => {
    const v = read(undefined, '1000');
    expect(v.ok).toBe(false);
    // El código es el de forma, NO el de techo: si saliera DEPTH_EXCEEDED
    // estaríamos comparando un valor que no validamos.
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it('T-U-DEPTH-7: un header REPETIDO (string[]) es AUSENCIA, no basura', () => {
    // Patrón `pick` de `middleware/a2a-key.ts:187-195`.
    const v = read(undefined, ['1', '2']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.depth).toBe(0);
  });
});

describe('readInboundContracting — paso 6: el techo', () => {
  it('T-U-CEIL-1: `depth >= depthMax` corta EN el techo (no `>`)', () => {
    const v = read(undefined, '2', ['gw.example.com'], 2);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe(CONTRACTING_DEPTH_EXCEEDED);
      if (v.code === CONTRACTING_DEPTH_EXCEEDED) {
        expect(v.depth).toBe(2);
        expect(v.depthMax).toBe(2);
      }
    }
  });

  it('T-U-CEIL-2: un nivel por debajo del techo PASA (gemelo positivo)', () => {
    const v = read(undefined, '1', ['gw.example.com'], 2);
    expect(v.ok).toBe(true);
  });
});

describe('readInboundContracting — pasos 1-3: largo, cantidad y forma de la cadena', () => {
  it('T-U-CHAIN-1: 8192 caracteres ⇒ CHAIN_MALFORMED (techo 762 con depthMax=2)', () => {
    const v = read('a'.repeat(8192), undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-U-CHAIN-2: 400 elementos válidos de 5 chars pasan el LARGO y los corta el CONTEO', () => {
    // 400 × "a.com," = 2400 chars > 762, así que con depthMax=2 lo corta el paso 1.
    // Para aislar el paso 2 hay que subir el techo de largo sin subir el conteo:
    // con depthMax=64 el largo permitido es 254×65 = 16510 > 2399.
    const raw = Array.from({ length: 400 }, () => 'a.com').join(',');
    expect(raw.length).toBeLessThan((253 + 1) * (64 + 1));
    const v = read(raw, undefined, ['gw.example.com'], 64);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
      if (v.code === CONTRACTING_CHAIN_MALFORMED) {
        expect(v.reason).toContain('400');
      }
    }
  });

  it('T-U-CHAIN-3: un eslabón basura se RECHAZA, no se ignora', () => {
    // Ignorarlo sería la forma de meter ruido para que un lector laxo pierda
    // NUESTRO eslabón en el mismo header.
    const v = read('otro-gw.example,https://basura', undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-U-CHAIN-4: CSV con espacios después de la coma es interop válido', () => {
    const v = read('otro-gw.example, tercero.example', undefined);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.chain).toEqual(['otro-gw.example', 'tercero.example']);
  });

  it('T-U-CHAIN-5: header ausente o vacío ⇒ cadena vacía (no rechazo)', () => {
    const cases = [undefined, '', '   '];
    expect(cases).toHaveLength(3);
    for (const raw of cases) {
      const v = read(raw, undefined);
      expect(v.ok, `chain=${JSON.stringify(raw)}`).toBe(true);
      if (v.ok) expect(v.chain).toEqual([]);
    }
  });

  it('T-U-CHAIN-6: un elemento vacío en el medio ⇒ CHAIN_MALFORMED', () => {
    const v = read('a.example,,b.example', undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });
});

describe('readInboundContracting — paso 5: membresía', () => {
  it('T-U-MEMBER-1: nuestro host en la cadena ⇒ LOOP con layer "chain"', () => {
    const v = read('otro-gw.example,gw.example.com', undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe(CONTRACTING_LOOP_DETECTED);
      if (v.code === CONTRACTING_LOOP_DETECTED) expect(v.layer).toBe('chain');
    }
  });

  it('T-U-MEMBER-2 (CD-15): mayúsculas Y punto final NO evaden la membresía', () => {
    const v = read('otro-gw.example,GW.EXAMPLE.COM.', undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-U-MEMBER-3: cadena de terceros ⇒ PASA (gemelo positivo)', () => {
    const v = read('otro-gw.example,tercero.example', undefined, [
      'gw.example.com',
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.chain).toEqual(['otro-gw.example', 'tercero.example']);
  });

  it('T-U-MEMBER-4: conjunto propio VACÍO ⇒ no hay membresía que chequear', () => {
    const v = read('otro-gw.example', undefined, []);
    expect(v.ok).toBe(true);
  });
});

describe('readInboundContracting — el ORDEN de los pasos es normativo (CD-16)', () => {
  it('T-U-ORDER-1: el LARGO gana sobre la membresía (no se materializa el arreglo)', () => {
    // La cadena CONTIENE nuestro host, pero excede el largo: el veredicto tiene
    // que ser el de forma. Si saliera LOOP, el chequeo de largo corre tarde.
    const raw = `gw.example.com,${'a'.repeat(8192)}`;
    const v = read(raw, undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-U-ORDER-2: la FORMA de la cadena gana sobre la profundidad ilegible', () => {
    const v = read('https://basura', '1e9');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_CHAIN_MALFORMED);
  });

  it('T-U-ORDER-3: la MEMBRESÍA gana sobre el techo', () => {
    // Los dos aplican; el que importa reportar es el bucle.
    const v = read('gw.example.com', '2', ['gw.example.com'], 2);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_LOOP_DETECTED);
  });
});

describe('isSelfDestination — la capa 1', () => {
  const hosts = ['gw.example.com'];

  it('T-U-SELF-1: el destino propio, en sus 5 variantes de URL, matchea', () => {
    expect(isSelfDestination('https://gw.example.com/compose', hosts)).toBe(
      true,
    );
    expect(isSelfDestination('https://GW.EXAMPLE.COM/compose', hosts)).toBe(
      true,
    );
    // punto final (CD-15)
    expect(isSelfDestination('https://gw.example.com./compose', hosts)).toBe(
      true,
    );
    // puerto: se compara sólo `hostname`, así que 8443 sigue siendo nosotros
    expect(
      isSelfDestination('https://gw.example.com:8443/compose', hosts),
    ).toBe(true);
    // userinfo
    expect(isSelfDestination('https://user:pw@gw.example.com/', hosts)).toBe(
      true,
    );
    // esquema http, mismo host
    expect(isSelfDestination('http://gw.example.com/compose', hosts)).toBe(
      true,
    );
  });

  it('T-U-SELF-2: un host ajeno NO matchea (gemelo positivo)', () => {
    expect(isSelfDestination('https://otro-agente.example/run', hosts)).toBe(
      false,
    );
    // sufijo/prefijo: `gw.example.com.evil.tld` no es nuestro host
    expect(
      isSelfDestination('https://gw.example.com.evil.tld/run', hosts),
    ).toBe(false);
    expect(isSelfDestination('https://xgw.example.com/run', hosts)).toBe(false);
  });

  it('T-U-SELF-3: los DOS hosts reales de prod NO matchean (AC-8)', () => {
    // Medido hoy contra prod: POST /discover → total 25, en
    // wasiai-v2.vercel.app (22) + wasiai-remittance-agents.vercel.app (3),
    // CERO apuntando al gateway. O sea que este guard rechaza 0 tráfico vivo.
    const urls = [
      'https://wasiai-v2.vercel.app/api/v1/agents/x/invoke',
      'https://wasiai-remittance-agents.vercel.app/api/invoke',
    ];
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(
        isSelfDestination(url, ['wasiai-a2a-production.up.railway.app']),
      ).toBe(false);
    }
  });

  it('T-U-SELF-4: `undefined` y URL ilegible ⇒ false SIN TIRAR (TRAMPA 1)', () => {
    // Producción no puede producirlo (`Agent.invokeUrl` es requerido) pero un
    // factory de `vi.mock` sí (medido: x402.non-evm-inbound.test.ts:143-147).
    expect(() => isSelfDestination(undefined, hosts)).not.toThrow();
    expect(isSelfDestination(undefined, hosts)).toBe(false);
    expect(isSelfDestination('', hosts)).toBe(false);
    expect(isSelfDestination('no-es-una-url', hosts)).toBe(false);
  });

  it('T-U-SELF-5: conjunto VACÍO ⇒ false (el guard no inventa identidad)', () => {
    expect(isSelfDestination('https://gw.example.com/compose', [])).toBe(false);
  });
});

describe('resolveSelfHosts — la MONOTONÍA es la propiedad', () => {
  it('T-U-SET-1: el orden de las fuentes fija el `canonicalId`', () => {
    process.env.BASE_URL = 'https://gw.example.com';
    process.env.A2A_SELF_HOSTS = 'alias.example.com';
    const r = resolveSelfHosts('hint.example.com');
    expect(r.hosts).toEqual([
      'gw.example.com',
      'alias.example.com',
      'hint.example.com',
    ]);
    expect(r.canonicalId).toBe('gw.example.com');
  });

  it('T-U-SET-2: sin `BASE_URL`, el primer `A2A_SELF_HOSTS` es el `canonicalId`', () => {
    process.env.A2A_SELF_HOSTS = 'alias.example.com,otro.example.com';
    expect(resolveSelfHosts().canonicalId).toBe('alias.example.com');
  });

  it('T-U-SET-3: sin env, el `hint` solo sostiene la identidad (CD-1)', () => {
    const r = resolveSelfHosts('gw.example.com');
    expect(r.hosts).toEqual(['gw.example.com']);
    expect(r.canonicalId).toBe('gw.example.com');
  });

  it('T-U-SET-4: sin env y sin hint ⇒ conjunto VACÍO y `canonicalId` null', () => {
    const r = resolveSelfHosts();
    expect(r.hosts).toEqual([]);
    expect(r.canonicalId).toBeNull();
  });

  it('T-U-SET-5: MONOTONÍA — agregar un hint sólo AGRANDA el conjunto', () => {
    // Ésta es la propiedad que hace admisible que el caller influya el hint: el
    // conjunto se usa sólo como predicado de NEGACIÓN, así que agrandarlo
    // produce MÁS rechazos, nunca menos. Un caller que manda
    // `Host: victima.example` logra que NOSOTROS nos neguemos a llamar a
    // victima.example en SU PROPIA petición: auto-DoS de un request, no bypass.
    //
    // ⛔ Y la primera línea de abajo es la CONDICIÓN, no un detalle del harness:
    // `BASE_URL` es lo que hace que exista un conjunto base que agrandar. Sin las
    // dos envs esta propiedad es verdadera como enunciado y vacía como garantía —
    // el caller DEFINE el conjunto y puede vaciarlo (AR-it2/BLQ-MED-2). El gemelo
    // que mide ESE caso es `T-L1-2e` (`services/compose.contracting-loop.test.ts`).
    process.env.BASE_URL = 'https://gw.example.com';
    const sinHint = resolveSelfHosts().hosts;
    const conHint = resolveSelfHosts('victima.example').hosts;
    for (const h of sinHint) expect(conHint).toContain(h);
    expect(conHint.length).toBeGreaterThanOrEqual(sinHint.length);
    // y el canonicalId NO se mueve por el hint
    expect(resolveSelfHosts('victima.example').canonicalId).toBe(
      'gw.example.com',
    );
  });

  it('T-U-SET-6: deduplica por forma canónica (mayúsculas y punto final)', () => {
    process.env.BASE_URL = 'https://GW.EXAMPLE.COM.';
    const r = resolveSelfHosts('gw.example.com');
    expect(r.hosts).toEqual(['gw.example.com']);
  });

  it('T-U-SET-7: un `BASE_URL` ilegible no aporta y no tira', () => {
    process.env.BASE_URL = '://';
    expect(() => resolveSelfHosts()).not.toThrow();
    expect(resolveSelfHosts().hosts).toEqual([]);
  });

  it('T-U-SET-8: `BASE_URL` como host pelado también aporta', () => {
    process.env.BASE_URL = 'gw.example.com';
    expect(resolveSelfHosts().hosts).toEqual(['gw.example.com']);
  });
});

describe('classifySelfHostsEnv — tres estados', () => {
  it('T-U-ENV-1: ausente / vacía ⇒ absent', () => {
    expect(classifySelfHostsEnv().state).toBe('absent');
    process.env.A2A_SELF_HOSTS = '   ';
    expect(classifySelfHostsEnv().state).toBe('absent');
  });

  it('T-U-ENV-2: con esquema ⇒ invalid (el operador CREE tenerla puesta)', () => {
    process.env.A2A_SELF_HOSTS = 'https://gw.example.com';
    const s = classifySelfHostsEnv();
    expect(s.state).toBe('invalid');
  });

  it('T-U-ENV-3: entrada DUPLICADA (por forma canónica) ⇒ invalid', () => {
    process.env.A2A_SELF_HOSTS = 'GW.example.com,gw.example.com.';
    const s = classifySelfHostsEnv();
    expect(s.state).toBe('invalid');
    if (s.state === 'invalid') expect(s.reason).toContain('DUPLICADA');
  });

  it('T-U-ENV-4: hostnames pelados ⇒ configured y canonicalizados', () => {
    process.env.A2A_SELF_HOSTS = 'GW.example.com, alias.example.com.';
    const s = classifySelfHostsEnv();
    expect(s.state).toBe('configured');
    if (s.state === 'configured') {
      expect(s.hosts).toEqual(['gw.example.com', 'alias.example.com']);
    }
  });
});

describe('resolveContractingDepthMax — fail-closed al default DEL CÓDIGO', () => {
  it('T-U-MAX-1: ausente ⇒ el default 2 (jamás Infinity)', () => {
    expect(resolveContractingDepthMax()).toBe(2);
    expect(DEFAULT_CONTRACTING_DEPTH_MAX).toBe(2);
  });

  it('T-U-MAX-2: valor legible en rango ⇒ ese valor', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '3';
    expect(resolveContractingDepthMax()).toBe(3);
    expect(contractingDepthMaxWarning()).toBeNull();
    // El borde bajo del rango aceptado: 1 SÍ se obedece y no avisa.
    process.env.A2A_CONTRACTING_DEPTH_MAX = '1';
    expect(resolveContractingDepthMax()).toBe(1);
    expect(contractingDepthMaxWarning()).toBeNull();
  });

  it('T-U-MAX-3: ilegible ⇒ default + warn (NO sin techo)', () => {
    const cases = ['abc', '1e9', '-1', '2.5', '1000', '0x10'];
    // Conteo asserteado: borrar una fila tiene que ponerse en rojo (CR/MNR-5).
    expect(cases).toHaveLength(6);
    for (const raw of cases) {
      process.env.A2A_CONTRACTING_DEPTH_MAX = raw;
      expect(resolveContractingDepthMax(), `raw=${raw}`).toBe(2);
      expect(contractingDepthMaxWarning(), `raw=${raw}`).toContain('ILEGIBLE');
    }
  });

  it('T-U-MAX-7: la ENV se trimea y el HEADER no — la asimetría es deliberada', () => {
    // ⚠️ NO "arreglar" esto igualando los dos caminos. CD-14 prohíbe el parseo
    // laxo de la PROFUNDIDAD DEL HEADER, que la controla un TERCERO y donde
    // `' 2'` leído como 2 es el ataque (parseInt(' 2',10) === 2). La ENV la
    // escribe el OPERADOR, no un atacante, y ahí `' 2'` es un espacio de más en
    // un panel de Railway: leerlo como 2 es lo correcto y falla igual al default
    // ante cualquier cosa que no sean dígitos.
    process.env.A2A_CONTRACTING_DEPTH_MAX = ' 2';
    expect(resolveContractingDepthMax()).toBe(2);
    expect(contractingDepthMaxWarning()).toBeNull();

    // el mismo string, en el header, se RECHAZA
    const v = read(undefined, ' 2');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it('T-U-MAX-4: por encima del tope de 64 ⇒ default + warn que dice el tope', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '65';
    expect(resolveContractingDepthMax()).toBe(2);
    expect(contractingDepthMaxWarning()).toContain('64');
  });

  it('T-U-MAX-5: vacía ⇒ default, y NO cuenta como mal escrita', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '  ';
    expect(resolveContractingDepthMax()).toBe(2);
    expect(contractingDepthMaxWarning()).toBeNull();
  });

  /**
   * Fix-pack AR/BLQ-MED-3. Antes de esto `0` se OBEDECÍA (el rango publicado era
   * `[0,64]`), era LEGIBLE —así que no había warn de arranque— y su consecuencia
   * era cerrar el servicio entero. La razón por la que no alcanzaba con
   * documentarlo: en este repo `maxBudget: 0` y el ceiling de exposición ausente
   * significan SIN LÍMITE, así que un `0` acá es casi siempre alguien pidiendo
   * "sin tope" y apagando el money-path.
   */
  it('T-U-MAX-6: `0` NO se obedece — cae al default y AVISA', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '0';
    expect(resolveContractingDepthMax()).toBe(2);
    const warning = contractingDepthMaxWarning();
    // El texto tiene que decir las dos cosas que el operador necesita saber.
    expect(warning).toContain('100% DEL TRAFICO');
    expect(warning).toContain('se apaga el deploy');
    // …y hacia dónde ir si de verdad quería el ajuste más restrictivo.
    expect(warning).toContain('es 1');
  });

  it('T-U-MAX-6b: por qué 0 sería fatal — el corte es `>=`, no `>`', () => {
    // ⚠️ Esta es la MEDICIÓN que justifica el `it` de arriba, y por eso llama a
    // `readInboundContracting` con el techo COMO ARGUMENTO en vez de por env: lo
    // que la env ya no permite es SETEARLO, no que la función lo acepte. Si algún
    // día el corte pasa a `>`, este `it` se pone en rojo y el de arriba pierde su
    // fundamento — que es exactamente lo que se quiere que se note.
    const v = read(undefined, undefined, ['gw.example.com'], 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_EXCEEDED);
    // Un caller directo, sin ningún header: el 100% del tráfico de hoy.
    expect(read(undefined, undefined, ['gw.example.com'], 1).ok).toBe(true);
  });
});

describe('buildOutboundContractingHeaders — AC-7 / CD-18', () => {
  it('T-U-OUT-1: agrega NUESTRO eslabón y la profundidad INCREMENTADA', () => {
    const h = buildOutboundContractingHeaders(
      ['a.example'],
      0,
      'gw.example.com',
    );
    expect(h[CONTRACTING_CHAIN_HEADER]).toBe('a.example,gw.example.com');
    expect(h[CONTRACTING_DEPTH_HEADER]).toBe('1');
  });

  it('T-U-OUT-2: cadena entrante vacía ⇒ salimos como primer eslabón', () => {
    const h = buildOutboundContractingHeaders([], 0, 'gw.example.com');
    expect(h[CONTRACTING_CHAIN_HEADER]).toBe('gw.example.com');
    expect(h[CONTRACTING_DEPTH_HEADER]).toBe('1');
  });

  it('T-U-OUT-3 (CD-18): sin `canonicalId` NO se emite NINGUNO de los dos', () => {
    // Emitir una cadena sin nuestro eslabón es PEOR que no emitir nada: el
    // siguiente gateway leería una traza que afirma no contenernos.
    const h = buildOutboundContractingHeaders(['a.example'], 1, null);
    expect(h).toEqual({});
    expect(Object.keys(h)).toHaveLength(0);
  });

  it('T-U-OUT-4: lo que emitimos es LEGIBLE por nuestro propio lector', () => {
    // La traza que emitimos tiene que ser comparable con el conjunto que
    // comparamos: si el emisor y el lector divergen, el transitivo no cierra ni
    // entre dos instancias nuestras.
    const h = buildOutboundContractingHeaders([], 0, 'gw.example.com');
    const v = readInboundContracting(
      {
        chain: h[CONTRACTING_CHAIN_HEADER],
        depth: h[CONTRACTING_DEPTH_HEADER],
      },
      ['gw.example.com'],
      DEFAULT_CONTRACTING_DEPTH_MAX,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_LOOP_DETECTED);
  });
});

describe('assertSelfHostsEnv — throw si ilegible, warn si vacío (patrón de assertDepositMinimumEnv)', () => {
  it('T-ENV-1: `A2A_SELF_HOSTS` con ESQUEMA ⇒ LANZA (no degrada a [] en silencio)', () => {
    // Es el caso en el que el operador CREE tener la identidad puesta. Degradarlo a
    // "sin alias" en silencio dejaría al guard sin reconocer como propio justo el
    // host que el operador declaró, y el síntoma (un bucle que pasa) no apunta a la
    // env var.
    process.env.A2A_SELF_HOSTS = 'https://gw.example.com';
    expect(() => assertSelfHostsEnv()).toThrow(/MAL ESCRITA/);
    // el mensaje dice el formato aceptado y por qué no bootea
    expect(() => assertSelfHostsEnv()).toThrow(/A2A_SELF_HOSTS/);
  });

  it('T-ENV-1b: entrada DUPLICADA ⇒ LANZA', () => {
    process.env.A2A_SELF_HOSTS = 'gw.example.com,GW.EXAMPLE.COM.';
    expect(() => assertSelfHostsEnv()).toThrow(/MAL ESCRITA/);
  });

  it('T-ENV-1c: con puerto o con path ⇒ LANZA', () => {
    const cases = ['gw.example.com:8443', 'gw.example.com/compose'];
    expect(cases).toHaveLength(2);
    for (const raw of cases) {
      process.env.A2A_SELF_HOSTS = raw;
      expect(() => assertSelfHostsEnv(), `raw=${raw}`).toThrow(/MAL ESCRITA/);
    }
  });

  it('T-ENV-2: AUSENTE (y sin BASE_URL) ⇒ devuelve el texto de WARN, NO lanza', () => {
    // NO THROW a propósito: no se pudo verificar el valor de `BASE_URL` en el
    // Railway de prod (NC-1) y voltear el servicio por eso sería un radio de
    // explosión mayor que el problema.
    let out: string | null = null;
    expect(() => {
      out = assertSelfHostsEnv();
    }).not.toThrow();
    expect(out).not.toBeNull();
    // El texto tiene que decir QUÉ queda cubierto y QUÉ no, o el operador no puede
    // decidir si le alcanza.
    expect(String(out)).toContain('Host');
    expect(String(out)).toContain('ALIAS');
    expect(String(out)).toContain('selfHostCount');
    // AR-it2/BLQ-MED-2: el texto decía que el Host entrante cubre el bucle directo,
    // a secas. Sin esta env ese Host no AGRANDA el conjunto —lo DEFINE— así que un
    // caller puede dejarlo en cero. El warn tiene que decirlo o el operador lee una
    // cobertura que no tiene. Testigo del comportamiento: `T-L1-2e`.
    expect(String(out)).toContain('HONESTO');
    expect(String(out)).toContain('DEFINE');
  });

  it('T-ENV-2b: `/health` publica `source:"request-only"` cuando el conjunto está vacío', () => {
    const health = readContractingGuardHealth();
    expect(health).toEqual({
      selfHostCount: 0,
      depthMax: 2,
      source: 'request-only',
    });
  });

  it('T-ENV-3: configurada ⇒ null, y `/health` publica `source:"env"` con el CONTEO (no los hosts)', () => {
    process.env.A2A_SELF_HOSTS = 'gw.example.com,alias.example.com';
    expect(assertSelfHostsEnv()).toBeNull();
    const health = readContractingGuardHealth();
    expect(health).toEqual({
      selfHostCount: 2,
      depthMax: 2,
      source: 'env',
    });
    // Que NO salgan los hosts es parte del contrato del campo: sale el conteo.
    expect(JSON.stringify(health)).not.toContain('gw.example.com');
  });

  it('T-ENV-4: sólo `BASE_URL` alcanza para que NO haya warn', () => {
    process.env.BASE_URL = 'https://gw.example.com';
    expect(assertSelfHostsEnv()).toBeNull();
    expect(readContractingGuardHealth().source).toBe('env');
  });
});

describe('T-FLAG-1 (CD-1) — barrido TEXTUAL: ninguna bandera gatea el corte', () => {
  /**
   * La convención por default de este repo para una env booleana es `=== 'true'`
   * con default OFF. Aplicada a este guard shippearía el guard APAGADO, y el
   * síntoma sería que no pasa nada — que se ve igual que "no hay bucles".
   *
   * Este barrido es el control EJECUTABLE de esa prohibición. Un comentario que
   * dice "no hay banderas" no se puede medir; esto sí, y se rompe el día que
   * alguien agregue una.
   *
   * ⚠️ SON DOS ARCHIVOS, NO UNO (fix-pack AR/MNR-2 + CR/MNR-2). Acá había un solo
   * path —el leaf—, que es justamente **el archivo donde una bandera NO iría**: el
   * leaf no tiene call-sites ni cadena de preHandlers. El AR lo midió: poniendo la
   * bandera en `middleware/contracting-guard.ts` el barrido seguía verde. El
   * middleware es el que decide si el guard de capa 2 corre para CADA request, o
   * sea el lugar natural de un interruptor.
   *
   * El path viejo también citaba `contracting-chain.flag.test.ts`, un archivo que
   * **no existe** (AR/MNR-3). Las citas de acá abajo se verifican solas: si el
   * archivo no existe, `readFileSync` tira.
   */
  const GUARD_SOURCES = [
    join(LIB_DIR, 'contracting-chain.ts'),
    join(LIB_DIR, '..', 'middleware', 'contracting-guard.ts'),
  ];

  it("no hay ningún `=== 'true'` en NINGUNO de los dos fuentes del guard", () => {
    // Conteo asserteado: si alguien saca un path de la lista, esto se pone rojo en
    // vez de barrer menos en silencio.
    expect(GUARD_SOURCES).toHaveLength(2);
    for (const file of GUARD_SOURCES) {
      // Tira si el path no existe ⇒ una cita rota no puede quedar verde.
      const src = readFileSync(file, 'utf8');
      expect(src.length, `${file} está vacío`).toBeGreaterThan(0);
      // Se buscan las dos formas de la convención, con comilla simple y doble.
      expect(src, `${file} tiene un === 'true'`).not.toMatch(/===\s*'true'/);
      expect(src, `${file} tiene un === "true"`).not.toMatch(/===\s*"true"/);
    }
  });

  it('las ÚNICAS envs que el guard lee son las dos de identidad/techo + BASE_URL', () => {
    // Si aparece una env nueva en este módulo, este test la pone en evidencia y
    // obliga a justificarla. Lo que se prohíbe no es "leer envs" (la identidad ES
    // una env): es leer un INTERRUPTOR.
    const src = readFileSync(join(LIB_DIR, 'contracting-chain.ts'), 'utf8');
    const reads = [
      ...src.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[([^\]]+)\])/g),
    ]
      .map((m) => m[1] ?? m[2])
      .filter((x): x is string => x !== undefined);
    const unique = [...new Set(reads)].sort();
    expect(unique).toEqual(['BASE_URL', 'DEPTH_MAX_ENV', 'SELF_HOSTS_ENV']);
  });

  it('el corte funciona con `process.env` limpio de banderas', () => {
    // Sólo la identidad. Ninguna bandera puesta.
    process.env.A2A_SELF_HOSTS = 'gw.example.com';
    expect(
      isSelfDestination(
        'https://gw.example.com/compose',
        resolveSelfHosts().hosts,
      ),
    ).toBe(true);
    // Y una allow-list de auto-contratación NO existe todavía (TD-360-1): si
    // alguien la shippea, tiene que venir vacía por default = denegar.
    expect(process.env.A2A_SELF_CONTRACTING_ALLOW).toBeUndefined();
  });
});

describe('El campo `contractingGuard` de /health está en LOS DOS handlers', () => {
  /**
   * `/health` está DUPLICADO: el handler de producción vive en `src/index.ts` y su
   * réplica para tests en `src/__tests__/e2e/setup.ts` (ese módulo hace
   * `await initAdapters()` a nivel de módulo, así que `src/index.ts` no se puede
   * importar desde un test — por eso la réplica existe).
   *
   * `T-HEALTH-CONTRACTING` (en `e2e.test.ts`) ejercita el campo de verdad, pero
   * **sólo puede ejercitar la RÉPLICA**. Si el campo se borrara del handler de
   * PRODUCCIÓN, ese test seguiría verde y `/health` de prod dejaría de publicar el
   * único instrumento que NC-1 designa para verificar la identidad después del
   * deploy. Este barrido textual es lo que cubre esa mitad.
   *
   * Es textual porque no hay otra forma: el handler de prod no es importable.
   */
  const HEALTH_HANDLERS = [
    join(LIB_DIR, '..', 'index.ts'),
    join(LIB_DIR, '..', '__tests__', 'e2e', 'setup.ts'),
  ];

  it('T-HEALTH-BOTH: los dos handlers llaman a `readContractingGuardHealth()`', () => {
    expect(HEALTH_HANDLERS).toHaveLength(2);
    for (const file of HEALTH_HANDLERS) {
      // `readFileSync` tira si el path no existe ⇒ una cita rota no queda verde.
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} no publica el campo en /health`).toContain(
        'contractingGuard: readContractingGuardHealth()',
      );
    }
  });
});

describe('El `selfHostHint` en TODOS los call-sites de producción', () => {
  /**
   * ⚠️ ESTE BLOQUE EXISTE PORQUE UNA FRASE NO ES UN CONTROL.
   *
   * Historia medida, y es lo que justifica el barrido: el fix-pack 1 cableó el
   * `hint` en `routes/compose.ts` y en las dos rutas de `routes/orchestrate.ts`, y
   * la HU declaró el residual como "por HTTP queda cubierto". **Había un tercer
   * caller HTTP que nadie enumeró**: `POST /agents/links/:token/redeem`
   * (`routes/agent-links.ts`, público, auth por posesión del token), que llama
   * `executeApprovedPlan` desde `services/agent-link.ts`. Con las dos envs ausentes
   * reproducía **byte por byte** el escenario que `T-L1-2c` congela como cerrado
   * (`debit` 1 vez, la invocación saliente contra nosotros mismos, `errorCode`
   * `undefined`), y encima el que paga es el que EMITIÓ el link, no el caller.
   *
   * El agujero no fue el código: fue que **el conjunto de call-sites no estaba
   * enumerado por nada que se cayera al crecer**. Este test es esa enumeración.
   *
   * ⛔ QUÉ NO PRUEBA ESTE TEST: que el hint valga algo. Sólo mira que el call-site
   * lo PASE. Que el guard corte, y que corte ANTES del débito, lo miden los tests
   * de orden de los cuatro sitios (`*.contracting-loop.test.ts`). Y no dice nada
   * sobre el valor del hint — un `Host` forjado sigue siendo un `Host` forjado
   * (ver `T-L1-2e` y la salvedad de `resolveSelfHosts`).
   */
  const SRC_DIR = join(LIB_DIR, '..');

  /** Los puntos de entrada al money-path que aceptan (o propagan) el hint. */
  const ENTRYPOINTS = [
    'orchestrateService.orchestrate(',
    'orchestrateService.executeApprovedPlan(',
    'this.executeApprovedPlan(',
    'composeService.compose(',
  ];

  /**
   * Call-sites SIN `selfHostHint`, con el motivo escrito **uno por uno**. Mismo
   * contrato que `test/ownership-filter-guard.exceptions.ts`: la omisión no se
   * tolera, se JUSTIFICA. Una entrada que sobra también rompe el test (abajo), así
   * que la lista no se puede podrir hacia el otro lado.
   */
  const SIN_HINT: Record<string, string> = {
    'mcp/tools/orchestrate.ts :: orchestrateService.orchestrate( #1':
      'caller NO-HTTP: el tool MCP no tiene `FastifyRequest` ni `Host` que pasar. ' +
      'Para este camino el conjunto de identidad depende SÓLO de BASE_URL / ' +
      'A2A_SELF_HOSTS. Residual declarado (implementation-log §7), NO cobertura.',
    'services/inbound-task.ts :: orchestrateService.orchestrate( #1':
      'caller NO-HTTP: ruteo in-process de tareas entrantes, arma su propio ' +
      '`OrchestrateRequest` sin request HTTP. Mismo residual que el tool MCP.',
    'services/orchestrate.ts :: this.executeApprovedPlan( #1':
      'NO construye un request nuevo: reenvía el MISMO `request` que recibió ' +
      '`orchestrate()`, con el `selfHostHint` que le haya puesto su llamador. ' +
      'Agregarle un hint acá sería un segundo lugar donde se decide la identidad.',
  };

  /** Quita comentarios para no contar una MENCIÓN como si fuera un call-site. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  /** Texto de los argumentos de la llamada que abre en `openIdx`. */
  function argsOf(src: string, openIdx: number): string {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(openIdx + 1, i);
      }
    }
    return src.slice(openIdx + 1);
  }

  function listProductionSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules')
          continue;
        listProductionSources(full, out);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
    return out;
  }

  /** Todos los call-sites de producción, con su veredicto. */
  function scan(): Array<{ key: string; hasHint: boolean }> {
    const sites: Array<{ key: string; hasHint: boolean }> = [];
    for (const file of listProductionSources(SRC_DIR).sort()) {
      const rel = relative(SRC_DIR, file).split(sep).join('/');
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const entry of ENTRYPOINTS) {
        let from = 0;
        let n = 0;
        for (;;) {
          const at = code.indexOf(entry, from);
          if (at === -1) break;
          n += 1;
          const open = at + entry.length - 1;
          sites.push({
            key: `${rel} :: ${entry} #${n}`,
            hasHint: argsOf(code, open).includes('selfHostHint'),
          });
          from = at + entry.length;
        }
      }
    }
    return sites;
  }

  it('T-HINT-CALLSITES: ningún call-site de producción sin `selfHostHint` sin excepción escrita', () => {
    const sites = scan();

    // ── CONTROLES, para que las dos aserciones de abajo no pasen en vacío ──────
    // Si el escáner dejara de encontrar call-sites (un rename, un stripComments
    // que se come el archivo), el `every` de más abajo sería trivialmente cierto.
    expect(sites.length).toBeGreaterThanOrEqual(
      Object.keys(SIN_HINT).length + 4,
    );
    // Los cuatro que HOY pasan el hint, nombrados: si uno se cae, se cae el test y
    // no queda tapado por un total.
    for (const esperado of [
      'routes/compose.ts :: composeService.compose( #1',
      'routes/orchestrate.ts :: orchestrateService.orchestrate( #1',
      'routes/orchestrate.ts :: orchestrateService.executeApprovedPlan( #1',
      'services/agent-link.ts :: orchestrateService.executeApprovedPlan( #1',
    ]) {
      const site = sites.find((s) => s.key === esperado);
      expect(site, `call-site desaparecido: ${esperado}`).toBeDefined();
      expect(site?.hasHint, `${esperado} dejó de pasar selfHostHint`).toBe(
        true,
      );
    }

    // ── LA ASERCIÓN ───────────────────────────────────────────────────────────
    // Un call-site nuevo sin hint rompe acá, que es el punto entero del barrido.
    const huerfanos = sites
      .filter((s) => !s.hasHint && SIN_HINT[s.key] === undefined)
      .map((s) => s.key);
    expect(huerfanos).toEqual([]);

    // ── Y la lista de excepciones no se puede pudrir hacia el otro lado ───────
    const vivos = new Set(sites.filter((s) => !s.hasHint).map((s) => s.key));
    expect(Object.keys(SIN_HINT).filter((k) => !vivos.has(k))).toEqual([]);
  });
});

describe('CD-14 — el candado del camino de la PROFUNDIDAD, acotado', () => {
  /**
   * CD-14 prohíbe `parseInt`/`Number(` **en el camino de la profundidad**, porque
   * los cuatro valores de la tabla del docblock (`'1e9'`, `''`, `' 2'`, `'2abc'`)
   * producen con esos lectores un número plausible y menor al techo: el modo de
   * falla no es un error, es **un guard que aplaude**. Por eso `digitsToInt`.
   *
   * ⚠️ EL CANDADO ERA "verificable con un grep" Y QUEDÓ ROMO EN EL MISMO COMMIT
   * (fix-pack AR/MNR-6): `grep -c "parseInt\|Number("` sobre el archivo da **8**
   * (medido en este árbol), casi todos dentro de los comentarios que EXPLICAN la
   * regla, más el `Number(sum.toFixed(6))` legítimo del rollup de fees. Un grep que
   * devuelve 8 no discrimina nada, así que la regla dejó de ser verificable en el
   * momento en que se escribió.
   *
   * Acá el barrido se acota a lo que la regla realmente prohíbe: **el código, sin
   * comentarios, fuera de `rollUpCascadedFee`** — que es la única función del
   * archivo que no toca la profundidad y sí necesita aritmética decimal. Medido en
   * este árbol: 1 sola ocurrencia en código, y está adentro del rollup.
   */
  const SRC = readFileSync(join(LIB_DIR, 'contracting-chain.ts'), 'utf8');

  /** Quita comentarios de bloque y de línea. El `[^:]` salva los `https://`. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('T-CD14-SWEEP: ningún `parseInt(`/`Number(` en código fuera del rollup de fees', () => {
    const code = stripComments(SRC);
    const start = code.indexOf('export function rollUpCascadedFee');
    expect(start, 'no se encontró `rollUpCascadedFee`').toBeGreaterThan(-1);
    const end = start + 1 + code.slice(start + 1).indexOf('\nexport function ');
    expect(end, 'no se encontró el final del rollup').toBeGreaterThan(start);

    const rollup = code.slice(start, end);
    const fueraDelRollup = code.slice(0, start) + code.slice(end);

    // ── LA ASERCIÓN ────────────────────────────────────────────────────────
    expect(fueraDelRollup).not.toMatch(/parseInt\(|Number\(/);

    // ── CONTROLES, para que el `not.toMatch` de arriba no pase por accidente ──
    // 1 · el stripper no se comió el archivo (si devolviera '' todo pasaría).
    expect(fueraDelRollup).toContain('function digitsToInt');
    expect(fueraDelRollup).toContain('DECIMAL_1_TO_3_DIGITS.test');
    // 2 · la partición apunta a la función correcta y NO está vacía.
    expect(rollup).toContain('cascadedOrchestrationFeeStatus');
    // 3 · control POSITIVO del regex: el rollup SÍ tiene el `Number(` legítimo, así
    //     que el barrido está mirando un patrón que existe en este archivo.
    expect(rollup).toMatch(/Number\(/);
  });
});

describe('CD-16 — el `split` NO se ejecuta sobre un header que excede el largo', () => {
  /**
   * Esto es lo que distingue "rechaza el header de 8 KB" de "rechaza el header de
   * 8 KB SIN materializar el arreglo que el tercero pidió". Un test que sólo mire el
   * código de error pasa igual con el chequeo de largo DESPUÉS del split, y ahí el
   * trabajo ya se hizo: la protección es contra el trabajo, no contra el valor.
   *
   * El espía registra el LARGO del receptor de cada `split`, así que se puede
   * afirmar que ninguno fue el string gigante sin depender de cuántos otros `split`
   * corran (los hay: la env de hosts usa `split(',')`).
   */
  /**
   * ⚠️ TESTIGO ÚNICO DE `MUT-09`. Medido: mover el chequeo de largo a DESPUÉS del
   * `split` deja la suite completa en **1 solo rojo, y es éste**
   * (MEDIDO: exit=1, 1 rojos, en `6f252ad`).
   *
   * Consecuencia práctica, y por eso está escrito acá y no sólo en el `.md`:
   * **cambiarle el input a este `it` lo apaga igual que borrarlo** (CD-22). Si el
   * `'a'.repeat(8192)` baja por debajo del techo de largo, o si el espía deja de
   * envolver `String.prototype.split`, el mutante sobrevive y NADA MÁS en el repo
   * lo nota — el código de error que devuelve el guard es el MISMO con el chequeo
   * antes o después del split, así que ningún test de veredicto puede reemplazarlo.
   */
  it('T-CHAIN-1-SPY: con 8192 caracteres, ningún `split` recibe ese string', () => {
    const original = String.prototype.split;
    const receiverLengths: number[] = [];
    try {
      String.prototype.split = function (
        this: string,
        ...args: Parameters<typeof original>
      ) {
        receiverLengths.push(this.length);
        return original.apply(this, args);
      } as typeof original;

      const big = 'a'.repeat(8192);
      const verdict = readInboundContracting(
        { chain: big, depth: undefined },
        ['gw.example.com'],
        DEFAULT_CONTRACTING_DEPTH_MAX,
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe(CONTRACTING_CHAIN_MALFORMED);
      // LA ASERCIÓN QUE IMPORTA: el string gigante nunca fue el receptor de un split.
      expect(receiverLengths).not.toContain(8192);
    } finally {
      String.prototype.split = original;
    }
  });

  it('T-CHAIN-1-SPY-b: control positivo — una cadena DENTRO del largo SÍ se splitea', () => {
    // Sin este control, el `it` de arriba pasaría también si `readInboundContracting`
    // no splitease NUNCA (por ejemplo si alguien lo reescribe con otro parser), y
    // entonces no estaría midiendo el ORDEN sino un accidente.
    const original = String.prototype.split;
    const receiverLengths: number[] = [];
    try {
      String.prototype.split = function (
        this: string,
        ...args: Parameters<typeof original>
      ) {
        receiverLengths.push(this.length);
        return original.apply(this, args);
      } as typeof original;

      const chain = 'a.example,b.example';
      const verdict = readInboundContracting(
        { chain, depth: undefined },
        ['gw.example.com'],
        DEFAULT_CONTRACTING_DEPTH_MAX,
      );
      expect(verdict.ok).toBe(true);
      expect(receiverLengths).toContain(chain.length);
    } finally {
      String.prototype.split = original;
    }
  });
});

describe('readCoordinatorFee / rollUpCascadedFee — AC-11 y CD-5', () => {
  it('T-U-FEE-1: sin `protocolFeeStatus` ⇒ undefined (no es un coordinador)', () => {
    expect(readCoordinatorFee({ result: 'ok' })).toBeUndefined();
    expect(readCoordinatorFee({})).toBeUndefined();
  });

  it('T-U-FEE-2: `charged` con monto finito > 0 ⇒ declared true', () => {
    expect(
      readCoordinatorFee({
        protocolFeeStatus: 'charged',
        protocolFeeUsdc: 0.02,
      }),
    ).toEqual({ declared: true, usdc: 0.02 });
  });

  it('T-U-FEE-3 (CD-5): declarado pero sin monto usable ⇒ declared FALSE, nunca usdc 0', () => {
    // Los cinco modos en que un sobre llega sin monto usable. En NINGUNO se
    // fabrica un cero: "no lo declaró" no es "cobró cero".
    const sobres = [
      { protocolFeeStatus: 'unknown' },
      { protocolFeeStatus: 'not_charged' },
      { protocolFeeStatus: 'charged' }, // sin monto
      { protocolFeeStatus: 'charged', protocolFeeUsdc: 0 }, // se contradice
      { protocolFeeStatus: 'charged', protocolFeeUsdc: Number.NaN },
    ];
    // Son CINCO modos, y el conteo se asserta: borrar una fila tiene que ponerse
    // en rojo, no barrer un caso menos en silencio (fix-pack CR/MNR-5).
    expect(sobres).toHaveLength(5);
    for (const raw of sobres) {
      const out = readCoordinatorFee(raw);
      expect(out, JSON.stringify(raw)).toEqual({ declared: false });
      expect(out).not.toHaveProperty('usdc');
    }
  });

  it('T-U-FEE-4: `charged` con monto NO numérico (string) ⇒ declared false', () => {
    // Lo escribe un tercero: un `"0.02"` no se coerciona a número.
    expect(
      readCoordinatorFee({
        protocolFeeStatus: 'charged',
        protocolFeeUsdc: '0.02',
      }),
    ).toEqual({ declared: false });
  });

  /**
   * ⚠️ TESTIGO ÚNICO del guard de tipo de `readCoordinatorFee` (fix-pack, AR/BLQ-MED-2).
   *
   * El `in` de JavaScript **TIRA** sobre un primitivo, no devuelve `false`:
   * `'protocolFeeStatus' in 'plain-string'` ⇒ `TypeError`. El argumento venía de
   * un `as Record<string, unknown>` sobre `response.json()`, que es una promesa a
   * `tsc` y no un hecho: un agente puede responder 200 con un JSON escalar.
   *
   * Por qué el modo de falla es CARO y no cosmético: el throw sube al catch
   * per-step de `execute()`, que corre **después** del `budgetService.debit` de ese
   * step ⇒ el caller queda **cobrado por un step que ahora falla**. En el árbol
   * base (`3823580`) ese mismo body funcionaba, así que es una REGRESIÓN de cobro.
   *
   * Este `it` es el único que ejercita los cinco primitivos. Cambiarle el input
   * (dejar sólo objetos) lo apaga igual que borrarlo.
   */
  it('T-U-FEE-5: body JSON NO-OBJETO (string/número/bool/null) ⇒ undefined, y NO TIRA', () => {
    const scalars: unknown[] = ['plain-string', 42, true, null, undefined];
    // El conteo se asserta para que borrar una fila ponga esto en rojo (CR/MNR-5).
    expect(scalars).toHaveLength(5);
    for (const raw of scalars) {
      expect(() => readCoordinatorFee(raw), String(raw)).not.toThrow();
      expect(readCoordinatorFee(raw), String(raw)).toBeUndefined();
    }
    // Control positivo: el guard de tipo NO se comió el caso que sí es objeto.
    expect(
      readCoordinatorFee({ protocolFeeStatus: 'charged', protocolFeeUsdc: 1 }),
    ).toEqual({ declared: true, usdc: 1 });
  });

  it('T-U-FEE-6: un ARRAY es `typeof object` y NO trae el sobre ⇒ undefined', () => {
    // `typeof [] === 'object'` y `'x' in []` no tira, así que el array pasa el
    // guard de tipo y cae por la vía normal (sin `protocolFeeStatus` ⇒ undefined).
    expect(readCoordinatorFee([])).toBeUndefined();
    expect(readCoordinatorFee([1, 2, 3])).toBeUndefined();
  });

  it('T-U-ROLL-1 (AC-8): ningún coordinador ⇒ `{}` ⇒ respuesta byte-idéntica', () => {
    expect(rollUpCascadedFee([undefined, undefined])).toEqual({});
    expect(rollUpCascadedFee([])).toEqual({});
  });

  it('T-U-ROLL-2: todos declararon ⇒ suma + `complete`', () => {
    expect(
      rollUpCascadedFee([
        { declared: true, usdc: 0.02 },
        { declared: true, usdc: 0.03 },
        undefined,
      ]),
    ).toEqual({
      cascadedOrchestrationFeeUsdc: 0.05,
      cascadedOrchestrationFeeStatus: 'complete',
    });
  });

  it('T-U-ROLL-3 (CD-5): uno no declaró ⇒ `partial`, y el total NO se lee como completo', () => {
    expect(
      rollUpCascadedFee([{ declared: true, usdc: 0.02 }, { declared: false }]),
    ).toEqual({
      cascadedOrchestrationFeeUsdc: 0.02,
      cascadedOrchestrationFeeStatus: 'partial',
    });
  });

  /**
   * Fix-pack AR/BLQ-BAJO-1. El monto lo escribe un TERCERO y `Number.isFinite` sola
   * no alcanza: `1e300` es finito. El techo es de REPRESENTABILIDAD (ver
   * `COORDINATOR_FEE_MAX_USDC`), y por encima de él la lectura honesta es la misma
   * que para cualquier otro monto inusable: `declared: false`.
   */
  it('T-U-FEE-7: monto por encima del techo ⇒ declared FALSE (no se recorta al techo)', () => {
    const sobre = (usdc: number) =>
      readCoordinatorFee({
        protocolFeeStatus: 'charged',
        protocolFeeUsdc: usdc,
      });
    // El borde exacto pasa…
    expect(sobre(1_000_000_000)).toEqual({
      declared: true,
      usdc: 1_000_000_000,
    });
    // …y un centavo por encima, no.
    expect(sobre(1_000_000_000.01)).toEqual({ declared: false });
    const enormes = [1e300, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER];
    expect(enormes).toHaveLength(3);
    for (const enorme of enormes) {
      const out = sobre(enorme);
      expect(out, String(enorme)).toEqual({ declared: false });
      // ⛔ Y NO se recorta al techo: publicar el techo sería publicar un número que
      // el coordinador no declaró.
      expect(out).not.toHaveProperty('usdc');
    }
  });

  it('T-U-ROLL-4 (CD-5): NINGUNO declaró monto ⇒ `partial` SIN número inventado', () => {
    // Hubo cascada y no se sabe cuánto. Publicar `0` acá sería decir "los
    // coordinadores no cobraron nada", que es una afirmación que nadie hizo.
    const out = rollUpCascadedFee([{ declared: false }, { declared: false }]);
    expect(out).toEqual({ cascadedOrchestrationFeeStatus: 'partial' });
    expect(out).not.toHaveProperty('cascadedOrchestrationFeeUsdc');
  });

  /**
   * ⚠️ TESTIGO ÚNICO del cero FABRICADO (fix-pack AR/BLQ-BAJO-1).
   *
   * Medido en `71fdaf7`: `rollUpCascadedFee([{declared:true, usdc:1e-9}])` devolvía
   * `{cascadedOrchestrationFeeUsdc: 0, cascadedOrchestrationFeeStatus:'complete'}`.
   * El monto era declarado y > 0; el `0` lo fabricaba el redondeo
   * (`Number((1e-9).toFixed(6)) === 0`, medido). Publicado con `complete`, o sea
   * afirmando SIN DUDA que los coordinadores no cobraron nada — la afirmación exacta
   * que CD-5 prohíbe inventar. Y el monto lo controla un tercero.
   *
   * ⛔ Cambiar el `1e-9` por un número que sobreviva al redondeo apaga este `it`
   * igual que borrarlo (CD-22): lo que se mide es el borde del redondeo.
   */
  it('T-U-ROLL-5 (CD-5): un monto que el redondeo lleva a 0 se OMITE, no se publica', () => {
    // Precondición medida, para que el `it` no dependa de una creencia sobre toFixed.
    expect(Number((1e-9).toFixed(6))).toBe(0);

    const out = rollUpCascadedFee([{ declared: true, usdc: 1e-9 }]);
    expect(out).not.toHaveProperty('cascadedOrchestrationFeeUsdc');
    // El status SÍ se publica: que hubo cascada se sabe. Lo que no se sabe con la
    // resolución de este campo es cuánto.
    expect(out).toEqual({ cascadedOrchestrationFeeStatus: 'complete' });
    // Control positivo: un monto que SÍ sobrevive al redondeo se publica igual que
    // siempre. Sin esto, el `it` pasaría también si se omitiera SIEMPRE el número.
    expect(rollUpCascadedFee([{ declared: true, usdc: 0.000002 }])).toEqual({
      cascadedOrchestrationFeeUsdc: 0.000002,
      cascadedOrchestrationFeeStatus: 'complete',
    });
  });

  /**
   * ⚠️ TESTIGO ÚNICO del `null` publicado (fix-pack AR/BLQ-BAJO-1).
   *
   * Medido: `JSON.stringify({a: Infinity})` ⇒ `{"a":null}`. Un `null` en un campo de
   * plata es indistinguible de "no aplica", y los sumandos los controla un tercero.
   *
   * Este caso hoy NO se alcanza vía `readCoordinatorFee` (el techo
   * `COORDINATOR_FEE_MAX_USDC` lo cierra aguas arriba), pero esta función es pura y
   * exportada: la aserción es que **no confía en su llamador**. Por eso el input se
   * arma acá directamente y no pasando por el lector.
   */
  it('T-U-ROLL-6: una suma no finita NO se publica (y no sale como `null` por JSON)', () => {
    expect(JSON.stringify({ a: Number.POSITIVE_INFINITY })).toBe('{"a":null}');

    const out = rollUpCascadedFee([
      { declared: true, usdc: Number.MAX_VALUE },
      { declared: true, usdc: Number.MAX_VALUE },
    ]);
    expect(out).toEqual({ cascadedOrchestrationFeeStatus: 'complete' });
    // La aserción que importa: lo que se serializa no tiene un `null` de plata.
    expect(JSON.stringify(out)).not.toContain('null');
  });
});
