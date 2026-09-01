# Adversarial Review · WKH-372 · ola W3 · `chaski-v3` `f295a6f..781aafd`

## VEREDICTO: **RECHAZADO** — 1 `BLQ-MEDIO`, 2 `BLQ-BAJO`, 3 `MNR`

⚠️ Materializado por el ORQUESTADOR: el agente de AR no puede escribir `.md`.
Árbol restaurado y verificado byte a byte contra `git show HEAD:` (HEAD `781aafd`, `git status` vacío).

## Gate — corrido entero y en orden
`git add -A` → `npm run qa` **exit 0** (biome 310 archivos · tsc · tsc:scripts · **172 archivos / 3490 tests**) → `npm run build` **exit 0**.
Sin flake de `vuelta-por-enlace-carrera.test.tsx` en esta corrida.

## Verificaciones obligatorias

| Check | Resultado |
|---|---|
| Δ0 `flow.tsx` | ✅ 4453 · `numstat 8 8` contra `3178360` |
| Censos de `solana-wallet.ts` | ✅ **ninguno cambió** (9 marcadores idénticos). Los 76→78 / 127→130 son de WKH-373, fuera de alcance |
| CD-12 | ✅ sin salida; el copy nuevo no matchea `/\bSOL\b/` (lo clava `T-372-W3-10c`) |
| `src/infrastructure/a2a/` · `public/` | ✅ **0 archivos** cada uno |
| Ownership guard | ✅ **N/A** — cero `.from(` y cero `supabase.rpc(` nuevos |
| Copy | ✅ sin em dashes; `T-372-W3-10c` prohíbe `/fall(ó|o|ida)|error|no pudimos|venci/i` |
| 17 citas ancladas muestreadas | ✅ **17/17 resuelven** |

## Los seis vectores atacados

**1 · La sesión como credencial de dinero — OK, control positivo VERIFICADO.**
Mutante del secreto compartido ⇒ muere por la mitad (c) de `T-372-W3-2`: *"una sesión firmada con el secreto del PoP fue aceptada: expected 200 to be 403"*. **El 200 en ese rojo prueba que el `it` recorre el money-path entero.**
Forjar: imposible (HMAC + `timingSafeEqual` con chequeo de largo previo). Alargar: el `exp` va dentro del payload firmado. Otra dirección: `S4`. Otro cluster: `S5`. Vencimiento en el ms exacto: `<=`, probado con `nowMs === exp*1000`. Un `popChallenge` crudo como sesión: 403. Cero logs del token; `Cache-Control: no-store` en las 5 respuestas que lo llevan.

**2 · El binding (`TD-372-W3-ADDRESS-DEL-BODY`) — OK, y por una razón MÁS fuerte que la escrita.**
`authority.ts:153` hace `identityClaim = canonicalizeAddress(address)`, y `S4`/`P3` ya probaron la igualdad con la dirección de la sesión ⇒ `identityClaim === direccionProbada` **por el guard**, no por una propiedad de la librería.
Medido además: `canonicalizeAddress` es la identidad sobre 20.000 claves aleatorias (`{ok: 20000, noIdent: 0, rejected: 0}`). **Sin hallazgo.**

**3 · El 2º argumento opcional — OK.** Los únicos dos sitios de producción (`container.ts:161` y `:185`) lo pasan. Mutante (borrarlo de `:161`): `tsc` **exit 0** y `T-372-W3-16` **rojo** — *"la sesión se graba y nadie la lee"*. El riesgo lo cierra un `it` que **ejercita**, no un `toBeDefined()`.

**4 · La limitación declarada — OK, y el copy NO la contradice.** `InMemorySesionStore` es un `Map` de instancia y el container se crea por montaje ⇒ el salto por enlace da realm nuevo ⇒ `peek()` `null` ⇒ PoP. **Ninguna frase promete una firma menos en Chrome**, y `flow.tsx:3902` declara por qué se descartó la variante que lo habría prometido.

**5 · `T-065-21` — el Dev tiene razón; §8 y T37 del story file estaban EQUIVOCADOS.** Ese `it` compara **dos renders vivos** entre sí, no un `innerHTML` congelado. Verificado corriendo: con el mutante del copy gateado, `T-065-21` **siguió verde**. No había ningún test que tocar.

**6 · El falso KILLED — REPRODUCIDO.** Mutante A (sacar la 4ª frase) muere en la aserción de **calibración** (`expected 3 to be 4`) sin llegar a mirar la pantalla. Mutante B (gatear el render) muere en la de pantalla, que es la razón correcta. **El Dev lo reportó como falso KILLED en vez de disfrazarlo.**
Bonus: el mutante de `S3` **SOBREVIVE** (`80 passed`), exactamente como su propio comentario declara. Guard inalcanzable, declarado.

---

## HALLAZGOS

### 🔴 `BLQ-MED-1` · 9 citas que ESTA ola corrió y no re-derivó

Viola **`CD-W3-4`** (`sdd-w3.md:751`, `:569`: *"re-derivación de todas las citas nuevas **y de las que la ola movió**"*) y **`D14`** del story file.

W3 insertó +60 líneas en `prepare/route.ts` desde `:222`, +76 en `http-solana-prepare-gateway.ts` y +35 en `http-kyc-verdict-gateway.ts`. El Dev re-derivó las **ancladas** y dejó rotas las **NO ancladas** — justo las que `citas-ancladas.test.ts` **no mira por diseño** (su docblock `:10` lo dice). **Por eso el gate está verde.**

| # | Sitio que cita | Cita | Hoy apunta a | Correcto |
|---|---|---|---|---|
| 1 | `payout/authority.test.ts:390` | `prepare/route.ts:348` | comentario | `:408` |
| 2 | `composition/container.test.ts:1084` | `prepare/route.ts:311` | `})` | `:371` |
| 3-5 | `presentation/flow-vm.ts:750` | `:334`, `:345`, `:348` | comentarios | `:394`, `:405`, `:408` |
| 6 | `presentation/flow-vm.test.ts:2586` | `prepare/route.ts:334` | comentario | `:394` |
| 7 | `deeplink/pop-por-enlace.ts:4` | `http-solana-prepare-gateway.ts:193` | comentario | `:205` |
| 8 | `deeplink/conexion.ts:10` y `container.test.ts:749` | `…prepare-gateway.ts:222-235` | firma del tipo | ≈`:233-249` |
| 9 | `solana-wallet.ts:2374` | `http-kyc-verdict-gateway.ts:60` | **línea en blanco** | ≈`:80` |

**Y una cita nueva que nació falsa**: `app/api/kyc/verdict/route.ts:42` afirma que `authority.ts:50` cita `:343`; cita **`:362`**. El `343` es el número **pre-W3** (362 − 19 = el Δ neto de la ola). El Dev leyó el número **antes** de su propia edición.

**Impacto**: el mecanismo de navegación que este repo usa como documentación primaria queda mintiendo en 5 archivos, en la ruta del dinero, y la **asimetría** (unas re-derivadas, otras no) impide saber a cuáles creerle.

### 🟠 `BLQ-BAJO-2` · La sesión viaja al agente EXTERNO en el cuerpo de `/compose`

`app/api/payout/prepare/route.ts:447` — `const forwardBody = { ...body, kycVerificationId: rowVerificationId };` → `:457` `input: forwardBody` → `gateway-client.ts:400` (*"input TAL CUAL"*).

**Reproducción (medida con probe capturando `fetchMock`)**:
```
AR-PROBE status 200
AR-PROBE url https://gateway.test/compose | sessionToken en el body? true | len 618
```
El `sessionToken` llega verbatim al gateway A2A y de ahí al agente de `remittance-payout`, **que es un tercero elegido por capacidad**. Ese agente puede reenviarlo a `POST /api/payout/prepare` durante **30 minutos** y crear órdenes a nombre de esa dirección.

**Contexto honesto**: `popChallenge`+`popSignature` ya viajaban igual (residual `R-3`, declarado en `route.ts:209-212`). Lo que W3 agrega es **3x la ventana** y una credencial nueva, y **ninguno de los dos documentos lo declara**. Contradice el principio que el propio módulo defiende en `sesion-store.ts:22` (*"es una credencial al portador: at-rest en el navegador es superficie que no hace falta abrir"*) mientras la manda al disco de un tercero.
La línea `:447` **ya existe para sanear** lo que se forwardea (pisa `kycVerificationId`), así que el sitio del arreglo está escrito.

### 🟠 `BLQ-BAJO-1` · Una frase de cobertura falsificada por una edición de UNA línea

`sesion-store.ts:47-48`: *"la relación se ata con un candado estático… ⛔ **Si cambiás uno, el candado se pone rojo**"*.
**Reproducción (corrida)**: `sesion-de-posesion.ts:61`, `30 * 60` → `60 * 60` (sólo el servidor) ⇒ `Test Files 9 passed (9) · Tests 153 passed (153)`. **Verde.**
El candado ata la **desigualdad**, no los valores, y el docblock del propio `it` lo dice bien (`sesion-store.test.ts:95-96`). Las dos frases están a 40 líneas y se contradicen; la que un editor va a leer es la del módulo. Viola **`D16`** (*"ninguna frase nueva sin su input concreto que la pondría en rojo"*): ésta tiene su input, y el input la deja verde.

### 🟡 `MNR-1` · El repliegue reintenta ante CUALQUIER 403
`http-solana-prepare-gateway.ts:341`. `prepare` emite 403 con **tres** enums (`payout_pop_unverified`, `prepare_kyc_verdict_missing`, `payout_not_authorized`). Persona con sesión válida y sin fila de veredicto ⇒ POST → 403 → `pop.prove()` (prompt de billetera) → POST → **el mismo** 403. Cuesta un POST, un token de rate-limit y —en `payout_not_authorized`— **una consulta de más al proveedor de KYC**, o sea cupo. `T-372-W3-17` sólo mira el **status**, nunca el enum.

### 🟡 `MNR-2` · `.env.example` publica un exploit que hoy no reproduce
Dice que con el mismo valor *"cualquier anónimo se emitiría una sesión con un solo curl"*. **Falso hoy**: el payload del challenge no tiene `tipo` y muere en `sesion-de-posesion.ts:144` **antes** de que el secreto importe. El docblock del módulo lo dice **bien** (*"Si compartiera secreto **Y FORMA**"*); `.env.example` le borró la condición. Decisión correcta, motivo publicado falso.

### 🟡 `MNR-3` · El guard de reloj ilegible cubre la LECTURA y no la ESCRITURA
`sesion-store.ts:86-90`. `Number.isFinite(ahora)` sólo mira el **ahora**; si el reloj era ilegible en `record()`, `atMs` queda `NaN`, `NaN >= TTL` es `false` ⇒ la sesión se entrega **para siempre**. Reproducción: `AR-PROBE peek tras 100 anios: tok`. No alcanzable con el `Clock` real y falla hacia un POST desperdiciado.

---

## Las 12 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | 🟠 **BLQ-BAJO-2**. El resto OK: HMAC, `timingSafeEqual` con largo previo, secreto propio con control positivo, binding doble, cinco fallos colapsados en un 403 byte-idéntico, rama nueva **debajo** del rate-limit, `no-store`, cero logs, sesión acuñada sólo aguas abajo de `P1..P5` y sólo en los 200 |
| 2 | Error Handling | 🟡 **MNR-1**, **MNR-3**. Fail-closed en el resto |
| 3 | Data Integrity | ✅ bearer stateless reusable dentro del TTL, **declarado**, misma propiedad que el PoP |
| 4 | Performance | ✅ un HMAC por request |
| 5 | Integration | 🔴 **BLQ-MED-1**. El contrato de red es **aditivo y compatible**; la ausencia de la env es un no-op verificable |
| 6 | Type Safety | ✅ cero `any`; `SesionReader`/`SesionRecorder` los impone `tsc` |
| 7 | Test Coverage | ✅ **31 `it` nuevos**, cada uno con mutante declarado; 5 verificados corriendo |
| 8 | Scope Drift | ✅ con nota: 35 archivos vs 24, los 11 extra son 1-2 líneas de mantenimiento que `CD-W3-4` exige |
| 9-10 | Migrations · RPC | **N/A** |
| 11 | Cache Invalidation | ✅ TTL cliente 28 min **estrictamente menor** que servidor 30 |
| 12 | Afirmaciones sin testigo | 🔴 **BLQ-MED-1** · 🟠 **BLQ-BAJO-1** · 🟡 **MNR-2**, **MNR-3**. Del lado bueno: el Dev **declaró** el falso KILLED y el mutante de `S3` que sobrevive, y contradijo por escrito a su propio story file **con razón** |

## Check 7 — escala
**2475 líneas / 35 archivos** contra **1700 / 22** ⇒ **1,46x y 1,59x**. **Declarado por escrito antes de ocurrir.**
El exceso **no es relleno**: 31 `it` con mutante, ratio comentario/código en línea con la casa (53% y 64% contra 50% de `prepare/route.ts`). El desborde de archivos es casi todo mantenimiento de citas. Los ~170 renglones de `T-372-W3-0b/0c/0d/0e` miden la **premisa** sobre el árbol viejo: son evidencia, no guardián, y los pidió el story file ⇒ decisión de la spec, no del Dev. Observación para el CR.

## Fix-pack, en orden
1. **`BLQ-MED-1`** — re-derivar las 9 citas y **anclarlas al símbolo** para que el guard las cubra.
2. **`BLQ-BAJO-2`** — sacar `sessionToken`/`popChallenge`/`popSignature` del `forwardBody`, con su `it`. Cierra de paso la mitad de `R-3`.
3. **`BLQ-BAJO-1`** — corregir la frase a lo que el candado sí garantiza.
4. `MNR-1`/`MNR-2`/`MNR-3` — `MNR-1` es el único con costo operativo real.

*AR · WKH-372 ola W3 · 2026-09-01 · `chaski-v3@781aafd`*
