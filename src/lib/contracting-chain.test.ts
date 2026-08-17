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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  DEFAULT_CONTRACTING_DEPTH_MAX,
  isContractingDepthMaxMisconfigured,
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
    expect(canonicalizeHost('[::1]')).toBeNull();
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
    for (const raw of [' 2', '2abc', '0x10']) {
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
    for (const raw of [undefined, '', '   ']) {
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
    for (const url of [
      'https://wasiai-v2.vercel.app/api/v1/agents/x/invoke',
      'https://wasiai-remittance-agents.vercel.app/api/invoke',
    ]) {
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
    expect(isContractingDepthMaxMisconfigured()).toBe(false);
  });

  it('T-U-MAX-3: ilegible ⇒ default + misconfigured=true (NO sin techo)', () => {
    for (const raw of ['abc', '1e9', '-1', '2.5', '1000', '0x10']) {
      process.env.A2A_CONTRACTING_DEPTH_MAX = raw;
      expect(resolveContractingDepthMax(), `raw=${raw}`).toBe(2);
      expect(isContractingDepthMaxMisconfigured(), `raw=${raw}`).toBe(true);
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
    expect(isContractingDepthMaxMisconfigured()).toBe(false);

    // el mismo string, en el header, se RECHAZA
    const v = read(undefined, ' 2');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_MALFORMED);
  });

  it('T-U-MAX-4: por encima del tope de 64 ⇒ default + misconfigured', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '65';
    expect(resolveContractingDepthMax()).toBe(2);
    expect(isContractingDepthMaxMisconfigured()).toBe(true);
  });

  it('T-U-MAX-5: vacía ⇒ default, y NO cuenta como mal escrita', () => {
    process.env.A2A_CONTRACTING_DEPTH_MAX = '  ';
    expect(resolveContractingDepthMax()).toBe(2);
    expect(isContractingDepthMaxMisconfigured()).toBe(false);
  });

  it('T-U-MAX-6: `0` es LEGIBLE y su consecuencia es cerrar el servicio', () => {
    // No es un "sin límite extra": con techo 0 todo caller directo (depth 0)
    // cae en `depth >= depthMax`. Queda documentado acá y en `.env.example`
    // para que nadie lo lea como un no-op.
    process.env.A2A_CONTRACTING_DEPTH_MAX = '0';
    expect(resolveContractingDepthMax()).toBe(0);
    expect(isContractingDepthMaxMisconfigured()).toBe(false);
    const v = read(undefined, undefined, ['gw.example.com'], 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(CONTRACTING_DEPTH_EXCEEDED);
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
    for (const raw of ['gw.example.com:8443', 'gw.example.com/compose']) {
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
   */
  const GUARD_SOURCES = ['contracting-chain.ts'];

  it("no hay ningún `=== 'true'` en el fuente del guard", () => {
    for (const file of GUARD_SOURCES) {
      const src = readFileSync(join(LIB_DIR, file), 'utf8');
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
    for (const raw of [
      { protocolFeeStatus: 'unknown' },
      { protocolFeeStatus: 'not_charged' },
      { protocolFeeStatus: 'charged' }, // sin monto
      { protocolFeeStatus: 'charged', protocolFeeUsdc: 0 }, // se contradice
      { protocolFeeStatus: 'charged', protocolFeeUsdc: Number.NaN },
    ]) {
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

  it('T-U-ROLL-4 (CD-5): NINGUNO declaró monto ⇒ `partial` SIN número inventado', () => {
    // Hubo cascada y no se sabe cuánto. Publicar `0` acá sería decir "los
    // coordinadores no cobraron nada", que es una afirmación que nadie hizo.
    const out = rollUpCascadedFee([{ declared: false }, { declared: false }]);
    expect(out).toEqual({ cascadedOrchestrationFeeStatus: 'partial' });
    expect(out).not.toHaveProperty('cascadedOrchestrationFeeUsdc');
  });
});
