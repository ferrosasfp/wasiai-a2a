# Validation Report — HU WKH-225 · Corte A (paso suspendible y reanudable)

**Veredicto: APROBADO PARA DONE**
**Fecha**: 2026-08-23 · **Worktree**: `/home/ferdev/.openclaw/workspace/wt-225`
**Rama**: `feat/225-paso-suspendible-y-reanudable`
**🔒 SHA verificado por mí, en este worktree, con el árbol limpio: `ee8a10a`**
(`git diff HEAD --stat` vacío antes de correr el gate — así se evita repetir el modo de falla de
`c6f2b0f`: un gate reportado en un commit que no corresponde al contenido real de ese commit.)

---

## Historia corta de esta corrida de F4

1ª pasada (mismo día, commit `c6f2b0f`): **RECHAZADO**. `npm test` daba exit 1 —
`test/readme-numbers.test.ts` fallaba en los dos README (`expected 309 to be 310`), porque ese
commit agregó `test/wkh225-resume-step0-mirrors-compose.test.ts` (cierre de `CR-3`) sin re-derivar
los conteos, y el propio mensaje de `c6f2b0f` afirmaba un gate verde que no era cierto.

Fix del Dev, commit **`ee8a10a`**: subió los dos README de 309 a 310. Y corrigió un punto mío y del
orquestador: no eran seis sitios candidatos a desfasar, eran **dos** — `.env.example` (189
variables) y los archivos lintados (508) ya coincidían en `c6f2b0f` y sus asserts ya pasaban; lo
verificó corriendo los comandos, no asumiéndolo.

---

## Gate — corrido por mí contra `ee8a10a`, árbol limpio, una sola pasada

| Paso | Comando | Exit | Evidencia |
|---|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | **0** | `TypeScript compilation completed` |
| 2 | `npm run lint` | **0** | `biome check src/` → `Checked 508 files in 285ms. No fixes applied.` |
| 3 | `npm test` | **0** | `Test Files 304 passed \| 6 skipped (310)` · `Tests 6071 passed \| 19 skipped (6090)` |

Coincide byte a byte con lo que reportó el orquestador y con lo que afirma el mensaje de `ee8a10a`
— y esta vez la afirmación del commit **es verificable y cierta**, a diferencia de `c6f2b0f`.

### Contención del fix — `git diff c6f2b0f ee8a10a --stat`

```
 README.es.md                                       |  2 +-
 README.md                                          |  2 +-
 .../auto-blindaje.md                               | 49 +++++++++++++++++++++
 3 files changed, 51 insertions(+), 2 deletions(-)
```

**Cero `src/`, cero `test/`, cero guard `i > 0` (CD-7).** Un cambio de 1 línea en cada README (los
números `309`→`310`, verificados en `README.md:378` y `README.es.md:412`) más el registro del propio
hallazgo en `auto-blindaje.md`. Nada más se movió.

### Verificación independiente de los otros dos números (no sólo confiar en el verde de la suite)

```
grep -cE '^[A-Z][A-Z0-9_]*=' .env.example   → 189   (README.md:351 / README.es.md:385 ya decían 189)
```

Y `biome check src/` imprimió `Checked 508 files` por su cuenta — el mismo número que ambos README
ya declaraban antes de este fix. Los "seis sitios candidatos" del hallazgo original eran en realidad
tres números × dos idiomas; sólo el número de archivos de test estaba desfasado, y sólo ahí hubo diff.

---

## ACs — sin cambios respecto a la corrida anterior (no se re-ejecutan: ver nota)

Los 12 ACs ya se verificaron con evidencia de EJECUCIÓN (comando + resultado, más una mutación propia
sobre `src/routes/compose.ts:1973` que puso en rojo `T-RES-FEE-5` y fue revertida) en la corrida
contra `c6f2b0f`. El fix de `ee8a10a` no toca `src/` ni `test/` — el `git diff --stat` de arriba lo
confirma — así que no hay superficie nueva que ejecutar. Tabla resumen (detalle completo, con
comando exacto por AC, quedó ya registrado en esta misma corrida de F4 antes del fix):

| AC | Status | Testigo |
|---|---|---|
| AC-1 | PASS | `T-SUSP-1`, `T-SUSP-2` (`compose.suspend.test.ts:231,246`) |
| AC-2 | PASS | `T-SUSP-3`, `T-SUSP-4` (`:280,326`) |
| AC-3 | PASS | `T-SUSP-5` (`:351`) |
| AC-4 | PASS | `T-TOK-*` (`resume-token.test.ts`), `T-RES-12` (`compose.resume.test.ts:290`) |
| AC-5 | PASS | `T-RES-1/2` (`:348,366`), `T-RUN-1` (`suspended-run.test.ts:405`) |
| AC-6 | PASS | `T-RES-3` (`:375`), `T-RUN-2` (`:415`), `suspended-run.ownership.test.ts` (4) |
| AC-7 | PASS | `T-RES-4` (`:396`), `T-RUN-9` (`:465`, exactamente un residuo — reproducido por AR contra PG16) |
| AC-8 | PASS | `T-RES-8/8b` (`:453,465`), `P0-3` (`e2e/compose-flow.test.ts`, route+service reales) |
| AC-9 | PASS | `describe` AC-9 (`compose.suspend.test.ts:415`) |
| AC-10 | PASS | `T-CAP-1/2/3` (`capability-risk.test.ts`) |
| AC-11 | PASS | `T-REC-1/2/2b/2c/2d/2e/3` (`reconciliation.test.ts`) |
| AC-12 | PASS | `T-RES-10/11` (`compose.suspend.test.ts:586,628`) |

CD-7 (`T-SUSP-GUARD571`, ancla por contenido) y los 8 testigos `T-RES-FEE-1..6b` del hallazgo `CR-2`
(uno de ellos verificado ROJO por mutación mía y revertido) siguen en PASS — nada en su superficie
cambió entre `c6f2b0f` y `ee8a10a`.

---

## Drift — sin cambios respecto a la corrida anterior

5 archivos fuera del Scope IN declarado (24→28 en `c6f2b0f`), los 5 trazables a hallazgos de AR/CR de
esta misma HU. `ee8a10a` no agrega ni quita ningún archivo de código o test — sólo toca los dos README
y `auto-blindaje.md` — así que el conteo de Scope IN no cambia.

---

## AR/CR follow-up — sin cambios

5 BLOQUEANTE (AR ronda 1) + 3 MENOR (AR ronda 2) + 4 MENOR (CR) cerrados y verificados en commits
específicos. Deuda aceptada por escrito: `TD-225-01`, `TD-225-02`, `MNR-6`, `NC-1`, `NC-4`. El único
hallazgo nuevo de esta ronda de F4 (README desfasado en `c6f2b0f`) está cerrado en `ee8a10a` y
verificado por mí de forma independiente, no sólo leído del commit.

---

## Runtime / Integration checks — sin cambios: NO VERIFICABLE

Migración no aplicada a bdwv, bandera OFF por default, nada desplegado. Igual que en la corrida
anterior: no se simula, se declara **NO VERIFICABLE**.

---

## Veredicto final

**APROBADO PARA DONE.**

Los 12 ACs tienen evidencia de ejecución en PASS. El único motivo del rechazo anterior — el gate en
rojo por un desfase de 1 en el conteo de archivos de test que publican los README — está cerrado en
el commit **`ee8a10a`**, verificado por mí de forma independiente (gate completo corrido contra ese
SHA con el árbol limpio, diff de contención confirmado, y los dos números que el Dev dice que ya
estaban bien —189 y 508— re-verificados por mí y no sólo asumidos). No queda ningún hallazgo abierto
sin declarar. **Listo para DONE contra `ee8a10a`.**
