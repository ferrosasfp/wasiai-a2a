# WasiAI — Batería de entrenamiento para el jurado (50 preguntas)

> Para presentar SIN ser técnica. Cada respuesta tiene:
> **🎤 Decí esto** = la respuesta corta para memorizar (1-3 frases).
> **🛟 Si te aprietan** = salida para preguntas técnicas que no domines.
> Regla de oro: **honestidad + analogías**. Si no sabés algo técnico, no inventes — usá la salida 🛟.

**La salida universal (memorizá esta primero):**
> *"Excelente pregunta técnica. La versión corta es [analogía simple]. Mi socio puede entrar al detalle del código si quieren, pero el punto es [beneficio]."*
Decir "no soy yo la que escribe el código, pero te explico qué hace" es **fuerte**, no débil.

---

## 1. LO BÁSICO (lo primero que preguntan)

**P1. ¿Qué es WasiAI en una frase?**
🎤 *"Somos la capa de orquestación de la economía de agentes: descubrimos el agente correcto en cualquier marketplace, los combinamos en un flujo y resolvemos el pago entre ellos — sobre los rieles de Kite."*
🎤 (EN) *"We're the orchestration layer for the agent economy: we discover the right agent in any marketplace, compose them into one flow, and settle the payment between them — on Kite's rails."*

**P2. ¿Qué problema resuelven?**
🎤 *"Hoy los agentes de IA no se pueden contratar ni pagar entre sí fácilmente. Si una tarea necesita tres agentes distintos, alguien tiene que conectarlos y pagarles a mano. Nosotros hacemos eso automático, en una sola llamada."*

**P3. Explícamelo como si no supiera nada de esto / a mi abuela.**
🎤 *"Imaginá que querés mandar plata a tu familia en otro país. En vez de una sola app, hay tres robots especializados: uno verifica que todo esté en regla, otro busca la ruta más barata, y otro hace la entrega. Nosotros somos el director de orquesta que los pone a trabajar juntos y se aseguran de que cada uno cobre por su parte — en segundos."*

**P4. ¿Para quién es esto?**
🎤 *"Para los marketplaces de agentes y las apps que quieren ofrecer tareas complejas sin construir todo. Ellos llaman a nuestra capa y nosotros orquestamos los agentes y el pago."*

**P5. ¿Por qué debería importarme?**
🎤 *"Porque la economía de agentes está naciendo ahora y le falta la pieza que los conecta y los hace cobrar. Esa pieza somos nosotros, y ya funciona."*

**P6. ¿Por qué se llama WasiAI?**
🎤 *"'Wasi' es 'casa' en quechua — la casa donde los agentes se encuentran, trabajan y cobran. Somos un equipo con raíz latinoamericana resolviendo un problema global."*

## 2. EL PRODUCTO Y EL DEMO

**P7. ¿Qué construyeron exactamente?**
🎤 *"Un gateway que hace tres cosas: descubre agentes, los combina en un flujo (lo llamamos 'compose') y liquida el pago. Y un demo real, AgentShop, que manda remesas usando tres agentes que se pagan entre sí en la blockchain de Kite."*

**P8. ¿Qué es AgentShop / qué mostró el demo?**
🎤 *"Es nuestro demo de remesas. Pedís enviar plata a Latinoamérica y tres agentes trabajan: el de cumplimiento (KYC), el que busca la mejor ruta, y el que entrega. Cada uno cobra, y la liquidación queda registrada en Kite — se puede verificar en el explorador (KiteScan)."*

**P9. ¿Eso es real o es una simulación?**
🎤 *"Real. Las transacciones que mostramos están en la blockchain de Kite, en testnet — cualquiera puede clickear el hash y verlas en KiteScan. No es un video ni un mockup."*

**P10. ¿Por qué testnet y no dinero real?**
🎤 *"Porque mover dinero real requiere licencias de transmisión y un partner regulado — eso es un trámite, no un problema técnico. En testnet probamos que todo el flujo funciona end-to-end. El paso a producción es regulatorio, no de ingeniería."*

**P11. ¿Qué es un "agente"?** (no técnica)
🎤 *"Un programa de IA que hace una tarea específica y puede cobrar por ella — como un freelancer digital. Nuestro trabajo es contratar al freelancer correcto, combinarlo con otros y pagarle automáticamente."*

**P12. ¿Cuánto tardaron en construir esto?**
🎤 *"Lo construimos para este hackathon, sobre una base que ya veníamos desarrollando. Está endurecido: 1.649 tests automáticos pasando."* (no des una fecha exacta si no la sabés)

## 3. POR QUÉ KITE (clave para este jurado)

**P13. ¿Por qué construyeron sobre Kite?**
🎤 *"Porque Kite resuelve lo que nosotros NO queremos reinventar: la identidad del agente (Passport) y el pago (x402). Nosotros ponemos la capa de arriba — orquestar y combinar agentes. Encajamos perfecto."*

**P14. ¿Qué de Kite usan exactamente?**
🎤 *"Tres cosas: el Agent Passport para la identidad, el estándar x402 para el pago, y liquidamos en la red de Kite (Kite Ozone). Está todo integrado y desplegado."*

**P15. ¿Cómo ayuda esto a Kite? / ¿por qué deberían listarlos?**
🎤 *"Le traemos agentes y volumen: cada flujo que orquestamos son transacciones en Kite. Y extendemos el alcance de un agente de Kite — con su Passport puede contratar agentes en otras redes como Avalanche y Base. Crecemos cuando Kite crece."*

**P16. ¿Qué es el Agent Passport?**
🎤 *"Es como el pasaporte/billetera del agente: prueba quién es y le pone límites de gasto que controla el usuario. Nosotros lo usamos para que cada agente del flujo se identifique y cobre de forma segura."*

**P17. ¿Qué les falta de Kite? (el famoso 'gate')**
🎤 *"Una sola cosa: que nos listen en su discovery. Todo nuestro lado funciona; el pago Passport en vivo se desbloquea cuando Kite nos incluye en su lista. Ese es nuestro pedido al jurado."*

## 4. TÉCNICAS — versión simple + salida 🛟

**P18. ¿Cómo funciona técnicamente?**
🎤 *"En una llamada: recibimos el pedido, buscamos los agentes en los marketplaces, los ejecutamos en orden, y liquidamos el pago de cada uno en la blockchain. Seguro y automático."*
🛟 *"El detalle de implementación lo puede ampliar mi socio, pero el flujo es ese."*

**P19. ¿Qué es x402?**
🎤 *"Es el estándar de pago para agentes — la forma en que un agente le paga a otro de manera automática y barata. Es de Kite, y nosotros lo hablamos nativamente."*
🛟 *"Técnicamente usa firmas y liquidación on-chain; el punto es que el pago viaja con la petición, sin tarjeta ni intermediario."*

**P20. ¿Cómo se pagan los agentes entre sí?**
🎤 *"Cada agente tiene un precio. Cuando lo usamos en un flujo, se le descuenta del presupuesto del usuario y se liquida en la blockchain. Todo queda registrado y verificable."*

**P21. ¿Es seguro? ¿Y si un agente es malicioso?**
🎤 *"Sí, está pensado para eso. El usuario pone límites de gasto que no se pueden pasar, validamos cada conexión para que nadie se cuele, y si algo falla, el sistema se cierra en vez de seguir pagando. La seguridad es nuestra prioridad porque orquestamos agentes que no son nuestros."*
🛟 *"Tenemos protecciones contra ataques de red (SSRF), control de propiedad de datos y 'fail-closed'. El detalle técnico lo amplía mi socio."*

**P22. ¿Escala? ¿aguanta millones de transacciones?**
🎤 *"Sí. Nuestro gateway crece horizontal y la parte pesada —los micropagos— la resuelven los rieles de Kite, que están hechos para volumen. Está diseñado para escalar."*
🛟 *"Para micropagos sub-centavo de alta frecuencia, Kite usa 'state channels'; por eso liquidamos a través de ellos."*

**P23. ¿Qué es 'cross-chain' y por qué importa?**
🎤 *"Que un agente en una blockchain puede contratar y pagar a un agente en OTRA blockchain, sin que el usuario se entere de la complejidad. Importa porque ningún agente vive en una sola red — y nosotros los conectamos a todas."*

**P24. ¿Quién controla el dinero?**
🎤 *"El usuario, siempre. Nosotros no custodiamos fondos — solo coordinamos. Los límites y los permisos viven en el Passport del usuario, y el pago se liquida directo en la blockchain."*

**P25. ¿Qué pasa si un agente del flujo falla a la mitad?**
🎤 *"No se paga lo que no se completó. Si el flujo se rompe en el paso 2, no se libera el pago del paso 3. Se llama 'fail-closed'."*

**P26. ¿Dónde está la blockchain en todo esto?**
🎤 *"En el pago. La identidad del agente y la liquidación de cada cobro viven en la blockchain de Kite — eso es lo que lo hace verificable y sin intermediarios."*

**P27. ¿Esos hashes que mostraron son reales? ¿Los puedo verificar?**
🎤 *"Sí, clickealos. Abren la transacción real en KiteScan, el explorador de Kite. Son liquidaciones de verdad en testnet."*
🛟 (honesto, si preguntan por las cross-chain) *"Las tres transacciones cross-chain corren con billeteras de demo, así que el origen y el destino son la misma — pero el flujo criptográfico es idéntico al de producción."*

## 5. NEGOCIO Y MERCADO

**P28. ¿Cómo ganan dinero?**
🎤 *"Cobramos 1% de cada flujo que orquestamos, automático y en la blockchain. Por cada mil millones orquestados, diez millones recurrentes. Ya está implementado."*

**P29. ¿Qué tan grande es el mercado?**
🎤 *"La economía de agentes mueve hacia billones; Kite apunta a un mercado de billones en pagos de agentes. Nosotros somos la capa que conecta y cobra en ese mercado."*

**P30. ¿Quién es el cliente?**
🎤 *"Los marketplaces de agentes y las apps que quieren ofrecer tareas complejas. Ellos llaman a nuestra capa en vez de construir orquestación y pagos desde cero."*

**P31. ¿Cómo van a conseguir usuarios? (chicken-and-egg)**
🎤 *"Arrancamos con un caso que duele: remesas a Latinoamérica. Eso ya genera transacciones reales y nos obliga a tener agentes de verdad. Después abrimos la capa a más marketplaces. No esperamos a que el ecosistema exista — lo sembramos."*

**P32. ¿Quién es la competencia?**
🎤 *"Nadie hace los tres juntos: descubrir en cualquier marketplace + combinar agentes + pagar cross-chain. Los marketplaces venden una llamada; nosotros cobramos el flujo completo. Kite es el riel; nosotros la capa de arriba."*

**P33. ¿Por qué no usar simplemente PayPal o Stripe?**
🎤 *"Porque PayPal y Stripe son para humanos con tarjeta. Acá los que pagan son agentes de IA, en tiempo real, montos chiquitos, sin humano en el medio. Eso necesita rieles nuevos — los de Kite — y una capa que los orqueste."*

**P34. ¿Cuánto cuesta usarlo?**
🎤 *"1% del valor del flujo. Sin costos fijos de entrada — pagás cuando transaccionás."*

**P35. ¿No es esto solo un 'wrapper' / una cáscara sobre Kite?**
🎤 *"No. Kite es los rieles de pago; nosotros somos la inteligencia que decide QUÉ agentes usar, en qué orden, y los paga cross-chain. Es como decir que Uber es un wrapper de los autos — el valor está en la orquestación."*

## 6. TRACCIÓN Y ESTADO (sé honesta)

**P36. ¿Cuántos usuarios tienen?**
🎤 *"Hoy estamos en testnet con el demo funcionando end-to-end. No vendemos métricas infladas — lo que mostramos es que la tecnología funciona y está endurecida. Producción con usuarios reales depende del listing y el partner de compliance."*

**P37. ¿Qué es real hoy y qué falta?**
🎤 *"Real: identidad, pago, orquestación, liquidación on-chain, 1.649 tests. Falta: que Kite nos liste para activar el pago Passport en vivo, y el partner regulado para dinero real. Todo nuestro lado está construido."*

**P38. ¿Está en producción?**
🎤 *"El gateway está desplegado y corriendo; el demo es público. La liquidación es en testnet. El paso a mainnet es regulatorio, no técnico."*

## 7. REGULACIÓN Y RIESGO (preguntas filosas)

**P39. Remesas = mover dinero. ¿No necesitan licencia?**
🎤 *"Sí, y por eso el PRIMER agente del flujo es el de cumplimiento (KYC/AML). Nosotros no somos el que mueve el dinero — somos la capa de orquestación; el movimiento lo hace un partner regulado. El cumplimiento está dentro del flujo, no es un agregado."*

**P40. ¿Qué pasa con el lavado de dinero (AML)?**
🎤 *"Cada flujo pasa por el agente de KYC/AML antes de liquidar: verifica el remitente, su nivel, y la regla del caso. Si no pasa, no se liquida."*

**P41. ¿Qué es lo que más los puede matar?**
🎤 *"La adopción del lado de los marketplaces. Lo atacamos sembrando con un caso vertical —remesas— que ya genera transacciones desde el día uno."*

**P42. ¿Por qué Kite no los copia?**
🎤 *"Bienvenidos si lo hicieran — significaría que validamos la capa. Pero Kite es los rieles; construir la orquestación cross-chain agnóstica de marketplace no es su core, y nosotros ya la tenemos corriendo. Preferimos ser su aliado que su competencia."*

**P43. ¿Por qué no lo hace el propio marketplace?**
🎤 *"Porque cada marketplace tendría que reconstruir identidad, pago y orquestación cross-chain por su cuenta. Nosotros se lo damos listo — se enfocan en sus agentes, nosotros en conectarlos."*

## 8. EQUIPO Y VISIÓN

**P44. ¿Quiénes son? ¿Por qué ustedes?**
🎤 [bios reales del deck — di el nombre del fundador, el rol técnico, y la raíz LATAM]. *"Combinamos producto, técnica y entendimiento del problema de remesas en Latinoamérica."*

**P45. Si le preguntan a ELLA algo muy técnico que no sabe:**
🎤 *"Esa es para mi socio técnico — pero te doy la idea: [analogía simple]."* Nunca te quedes muda ni inventes. Pasala con elegancia.

**P46. ¿Dónde ven esto en 2 años?**
🎤 *"Siendo la capa de orquestación por defecto de la economía de agentes — la forma estándar en que cualquier app contrata y paga agentes, en cualquier red."*

**P47. ¿Qué harían con el premio / una inversión?**
🎤 *"Cerrar el partner de compliance para ir a producción con remesas reales, y abrir la capa a más marketplaces. El producto ya está; lo que aceleramos es la salida a mercado."*

**P48. ¿Cuál es su métrica más importante?**
🎤 *"El volumen orquestado — cuánto valor pasa por nuestros flujos. Es nuestro revenue y es transacciones para Kite a la vez."*

## 9. CURVEBALLS (las inesperadas)

**P49. Si te doy 30 segundos y nada de jerga, ¿qué hace tu producto?**
🎤 *"Conectamos robots de IA para que trabajen juntos en una tarea y se paguen entre sí, automáticamente. Lo probamos con remesas: tres robots mandan plata a otro país en segundos, y todo queda registrado en la blockchain."*

**P50. ¿Cuál es la parte más difícil de lo que construyeron?**
🎤 *"Lograr que agentes que no se conocen, de marketplaces distintos y en redes distintas, trabajen juntos y se paguen — de forma segura y sin que el usuario pierda el control del dinero. Esa coordinación es el corazón."*

---

## RECORDATORIOS PARA ELLA
1. **Sonreí y respirá.** Si no entendés la pregunta, pedí que la reformulen.
2. **3 frases máximo por respuesta.** Corto y claro gana.
3. **Si es muy técnica → usá la salida 🛟** ("eso lo amplía mi socio, pero la idea es..."). Es profesional, no es debilidad.
4. **Cerrá siempre apuntando al pedido:** *"y por eso pedimos que nos listen — todo nuestro lado ya funciona."*
5. **Honestidad:** "esto funciona, esto es testnet, esto son wallets de demo". Nunca inventes un número.
6. **Tu superpoder:** explicar lo complejo simple. Las analogías (director de orquesta, freelancers digitales, Uber) son tu fortaleza, no tu límite.
