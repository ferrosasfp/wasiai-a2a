/**
 * R-4 — la clasificación de capacidades, medida contra los nombres REALES del
 * catálogo.
 *
 * ⚠️ NINGÚN test de este archivo itera `DISBURSEMENT_CAPABILITIES` para después
 * preguntarle a `classifyCapability` si sus elementos son de desembolso: eso
 * comprueba que un `Set` se contiene a sí mismo y sobrevive a cualquier cambio de
 * la lista. Los nombres se escriben a mano, uno por uno, copiados de la evidencia
 * que los publica:
 *
 *   · `doc/sdd/170-wkh-172-remit-cashout-payout/done-report.md:202` — las 4 del
 *     agente de payout;
 *   · `doc/sdd/167-wkh-171-remit-corridor-fx/done-report.md:177` — las 3 del FX;
 *   · `doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md:190` — las 4 del KYC.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_CAPABILITIES,
  classifyCapabilities,
  classifyCapability,
  needsTightTrialQuota,
  requiresPinnedAgent,
} from './capability-risk.js';

describe('R-4 · qué capacidades DESEMBOLSAN', () => {
  it.each([
    'remittance-payout',
    'cashout',
    'value-delivery',
    'fiat-disbursement',
  ])('`%s` (registro de `remit-cashout-payout`) es DESEMBOLSO', (capability) => {
    expect(classifyCapability(capability)).toBe('disbursement');
  });

  it.each([
    'remittance-fx-quote',
    'usdc-to-pen',
    'corridor-pricing',
    'kyc-verification',
    'aml-screening',
    'travel-rule',
    'remittance-compliance',
  ])('`%s` (cotizar / validar) NO es desembolso', (capability) => {
    expect(classifyCapability(capability)).toBe('no-disbursement');
  });

  it('mayúsculas y espacios NO esquivan la clasificación', () => {
    // Sin normalizar, publicar `Remittance-Payout` compraba el cupo ancho con un
    // cambio de una tecla. El filtro de capabilities de discovery ya compara en
    // minúsculas (`services/discovery.ts:445-450`), así que un agente puede
    // declararlo así y seguir siendo encontrado por la misma búsqueda.
    expect(classifyCapability('Remittance-Payout')).toBe('disbursement');
    expect(classifyCapability('  VALUE-DELIVERY  ')).toBe('disbursement');
  });

  it('lo que no está en ninguna lista es `unclassified`, NO "inocuo"', () => {
    // `cashout-match` está en el catálogo (`doc/sdd/_INDEX.md:144`) y se dejó
    // AFUERA de la lista de inocuas a propósito: nombra un cashout y no se pudo
    // verificar que no entregue valor.
    expect(classifyCapability('cashout-match')).toBe('unclassified');
    expect(classifyCapability('lo-que-sea-que-publiquen-manana')).toBe(
      'unclassified',
    );
  });
});

describe('R-4 · la clasificación del AGENTE (todas sus capacidades)', () => {
  it('una sola capacidad de desembolso alcanza: el que además cotiza sigue siendo el que paga', () => {
    expect(
      classifyCapabilities(['remittance-fx-quote', 'remittance-payout']),
    ).toBe('disbursement');
  });

  it('todas verificadas inocuas → `no-disbursement` (el único caso que afloja el cupo)', () => {
    expect(classifyCapabilities(['remittance-fx-quote', 'usdc-to-pen'])).toBe(
      'no-disbursement',
    );
  });

  it('una sola sin clasificar contamina al conjunto', () => {
    expect(classifyCapabilities(['remittance-fx-quote', 'algo-nuevo'])).toBe(
      'unclassified',
    );
  });

  it.each([
    ['lista vacía', [] as unknown[]],
    ['sin capacidades (undefined)', undefined],
    ['null', null],
    ['entradas que no son strings', [{ nombre: 'payout' }, 42]],
    ['un string suelto en vez de arreglo', 'remittance-fx-quote' as never],
  ])('%s → `unclassified`: "no dice qué hace" NO es "no mueve plata"', (_caso, capabilities) => {
    expect(classifyCapabilities(capabilities)).toBe('unclassified');
  });
});

describe('R-4 · el lado seguro de lo desconocido', () => {
  it('desembolso y desconocido comparten el cupo ESTRECHO; sólo lo verificado-inocuo escapa', () => {
    // La decisión explícita: una capacidad nueva que mueva plata y que nadie haya
    // agregado a la lista recibe igual el cupo más restrictivo. Equivocarse en esta
    // dirección le aprieta el carril a un agente inocuo; equivocarse en la otra
    // entrega el `depositAddress` de una remesa.
    expect(needsTightTrialQuota(['remittance-payout'])).toBe(true);
    expect(needsTightTrialQuota(['una-capacidad-que-nadie-listo'])).toBe(true);
    expect(needsTightTrialQuota([])).toBe(true);
    expect(needsTightTrialQuota(['remittance-fx-quote'])).toBe(false);
  });
});

describe('T-CAP · WKH-225 — las 2 capacidades del camino hospedado del KYC', () => {
  // Los nombres se copian A MANO del sitio que los publica,
  // `wasiai-remittance-agents/src/manifest/registry.ts:76-77`, no de la lista
  // que este archivo verifica.
  it('T-CAP-1: `kyc-hosted-redirect` es no-disbursement', () => {
    expect(classifyCapability('kyc-hosted-redirect')).toBe('no-disbursement');
  });

  it('T-CAP-2: `legacy-single-shot-kyc` es no-disbursement', () => {
    expect(classifyCapability('legacy-single-shot-kyc')).toBe(
      'no-disbursement',
    );
  });

  it('T-CAP-3: las 6 capacidades REALES de remit-kyc-validator NO caen al cupo estrecho', () => {
    // 🔴 ÉSTE es el test con efecto medido, y los otros dos son su andamio.
    // Las 6 son las que el manifiesto declara HOY, en ese orden
    // (`registry.ts:66-77`): 4 nombran el ROL, 2 nombran el CAMINO.
    const LAS_SEIS = [
      'kyc-verification',
      'aml-screening',
      'travel-rule',
      'remittance-compliance',
      'kyc-hosted-redirect',
      'legacy-single-shot-kyc',
    ];
    expect(classifyCapabilities(LAS_SEIS)).toBe('no-disbursement');
    expect(needsTightTrialQuota(LAS_SEIS)).toBe(false);

    // Y la prueba de que el test no es vacuo: sacando las dos nuevas de la
    // lista clasificada, el conjunto REAL volvería al cupo estrecho. Eso es lo
    // que pasaba antes de esta HU.
    expect(
      needsTightTrialQuota([...LAS_SEIS, 'una-septima-sin-clasificar']),
    ).toBe(true);
  });

  it('agregar estas dos NO afloja nada más: `cashout-match` sigue afuera', () => {
    // Sigue sin poder verificarse que no entregue valor, y un "probablemente
    // no" no entra a una lista cuyo efecto es AFLOJAR un cupo del camino del
    // dinero.
    expect(classifyCapability('cashout-match')).toBe('unclassified');
    expect(needsTightTrialQuota(['cashout-match'])).toBe(true);
  });
});

describe('T-B · WKH-366 — las 2 capacidades del dialecto compose del KYC', () => {
  // Los nombres se copian A MANO del sitio que los publica,
  // `wasiai-remittance-agents/src/manifest/registry.ts:275` y `:300`, no de la
  // lista que este archivo verifica.
  it('T-B1: las dos nuevas son `no-disbursement`, NINGUNA cae a `unclassified`', () => {
    // 🔪 MATA: sacar cualquiera de las dos de `NON_DISBURSEMENT_CAPABILITIES`.
    // Sin ellas, publicar el camino que NO manda el documento por la red le
    // daría al agente el cupo ESTRECHO — el penal al revés.
    expect(classifyCapability('kyc-session-create')).toBe('no-disbursement');
    expect(classifyCapability('kyc-decision-read')).toBe('no-disbursement');
    expect(classifyCapability('kyc-session-create')).not.toBe('unclassified');
    expect(classifyCapability('kyc-decision-read')).not.toBe('unclassified');

    // Y el efecto medido: el conjunto REAL que va a declarar cada ficha nueva no
    // cae al cupo estrecho.
    expect(needsTightTrialQuota(['kyc-session-create'])).toBe(false);
    expect(needsTightTrialQuota(['kyc-decision-read'])).toBe(false);
  });

  it('T-B1: `requiresPinnedAgent` normaliza — mayúsculas y espacios NO son un bypass', () => {
    // 🔪 MATA: escribir `AUTHORIZATION_CAPABILITIES.has(capability)` sin
    // `normalize`. Con eso, `KYC-Decision-Read` esquivaría el guard del
    // Coordinador con un cambio de mayúsculas.
    expect(requiresPinnedAgent('kyc-session-create')).toBe(true);
    expect(requiresPinnedAgent('kyc-decision-read')).toBe(true);
    expect(requiresPinnedAgent('KYC-Decision-Read')).toBe(true);
    expect(requiresPinnedAgent('  kyc-decision-read ')).toBe(true);
    expect(requiresPinnedAgent('  KYC-SESSION-CREATE  ')).toBe(true);
  });

  it('T-B2 (CD-18): `AUTHORIZATION_CAPABILITIES` no contiene NINGUNA capacidad preexistente', () => {
    // 🔴 LA LISTA DE PREEXISTENTES SE ESCRIBE LITERAL ACÁ, no se deriva del
    // módulo que este test mide: derivarla de `DISBURSEMENT_CAPABILITIES` /
    // `NON_DISBURSEMENT_CAPABILITIES` haría que el test se moviera junto con lo
    // que vigila y aplaudiera cualquier cosa. Son las 15 que existían ANTES de
    // WKH-366 (4 de desembolso + 11 inocuas).
    //
    // 🔪 MATA: agregar `'kyc-verification'` —o cualquier otra preexistente— a
    // `AUTHORIZATION_CAPABILITIES`. Eso rompería con 400 a todo consumidor
    // externo que hoy componga un step de KYC por capacidad, y desde este repo
    // NO se puede medir quién hace eso.
    const PREEXISTENTES_ANTES_DE_WKH366 = [
      // DISBURSEMENT (4)
      'remittance-payout',
      'cashout',
      'value-delivery',
      'fiat-disbursement',
      // NON_DISBURSEMENT (11)
      'remittance-fx-quote',
      'usdc-to-pen',
      'corridor-pricing',
      'kyc-verification',
      'aml-screening',
      'travel-rule',
      'remittance-compliance',
      'remit.corridor-discovery',
      'kyc-check',
      'kyc-hosted-redirect',
      'legacy-single-shot-kyc',
    ];
    expect(PREEXISTENTES_ANTES_DE_WKH366).toHaveLength(15);

    for (const capability of PREEXISTENTES_ANTES_DE_WKH366) {
      expect(AUTHORIZATION_CAPABILITIES.has(capability), capability).toBe(
        false,
      );
      expect(requiresPinnedAgent(capability), capability).toBe(false);
    }

    // Y el set es EXACTAMENTE las dos nuevas: sin esto, agregar una tercera
    // capacidad que no esté en la lista de arriba pasaría inadvertida.
    expect([...AUTHORIZATION_CAPABILITIES].sort()).toEqual([
      'kyc-decision-read',
      'kyc-session-create',
    ]);
  });
});
