# Zuki Pay — Tiendita escolar con tarjetas NFC

Sistema para la cooperativa escolar de **Zuki Company (Morelia, Michoacán)**. Cada alumno tiene una tarjeta NFC; los padres/tutores recargan saldo en la cooperativa, los niños pagan con la tarjeta y **cada movimiento queda registrado** (incluidos los intentos rechazados). Montos en **pesos mexicanos (MXN)**, guardados internamente en centavos (enteros).

> ## ⚠️ El sistema funciona SOLO CON INTERNET (desde la versión 2.0)
> Ya no existe la operación sin conexión. **Todo** (ventas, recargas, tarjetas, alumnos, límites) se registra directo en el **servidor**, así la computadora, la tableta y el celular siempre ven lo mismo al instante.
> - Si no hay internet o el servidor no responde, en **todas** las pantallas (caja de escritorio, tableta, celular) aparece a pantalla completa: **“Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.”** y no se puede cobrar, recargar ni modificar nada. El sistema **reintenta solo** cada pocos segundos y, al volver la conexión, el aviso desaparece y los datos se vuelven a cargar del servidor.
> - **No hay cola de ventas guardadas para después.** Si una venta se estaba enviando justo cuando se cayó la conexión, se avisa que *no se pudo confirmar*: revise **Movimientos** antes de repetirla.
> - Capturas: [`80-sin-conexion.png`](docs/capturas/v2/80-sin-conexion.png) (app) y [`83-escritorio-sin-conexion.png`](docs/capturas/v2/83-escritorio-sin-conexion.png) (caja de escritorio al arrancar sin internet).

Consta de estas piezas, que comparten la misma lógica de negocio (`src/core`, ejecutada **solo en el servidor**):

| Pieza | Para quién | Dónde corre | Estado |
|---|---|---|---|
| **Servidor + app web (PWA)** | Todos: administrador, cajero, padres y superadministrador, desde computadora, tableta o celular | Render (https://cooperativa-nfc.onrender.com), VPS, Railway… | Completo |
| **Caja de escritorio** (Electron) | Administrador y cajero en la cooperativa | Windows / macOS (Linux para pruebas). **Cliente en línea**: abre la app del servidor y agrega el lector NFC PC/SC. **Requiere internet** | Completa |
| **Multi-escuela** + panel de **superadministrador** | Zuki Company (dueña de la plataforma) | En el servidor / PWA | Completo (ver sección 1b) |

> **Guía paso a paso para poner en marcha una escuela (lenguaje sencillo): [`GUIA_ARRANQUE_ESCUELA.md`](GUIA_ARRANQUE_ESCUELA.md).**

Forma de operar: la cooperativa cobra y recarga desde la **caja de escritorio** o desde el **navegador / tableta** (es la misma app); los padres consultan saldo e historial y configuran límites, prohibidos y bloqueos desde su celular. Todo pasa por el servidor en ese momento.

---

## 1. Funciones

**Administrador**
- Panel: ventas del día / semana / mes, recargas, tarjetas activas, saldo total en tarjetas, rechazos del día, productos más vendidos y gráfica de ventas por día (SVG).
- Productos: alta, edición, precio, categoría, activar/desactivar, eliminar (si tiene ventas solo se desactiva). Categorías.
- Tarjetas: registrar UID (con lector o a mano), asignar a alumno, bloquear/activar, **reportar perdida y transferir saldo** a una tarjeta nueva, quitar tarjeta (regresa al inventario si tiene saldo $0), ajustes de saldo con motivo. En *Tarjetas* se elige el alumno (opcional) y se pasa la tarjeta: **Enter registra/asigna**. No se permiten UID repetidos.
- **Asignar tarjeta desde el alumno** (*Alumnos y padres → 🪪 Asignar tarjeta* o pestaña *Tarjeta y perfil*): campo con **foco automático** donde se escribe el UID a mano o se pasa la tarjeta por un **lector USB tipo teclado de 125 kHz** (o NFC); **Enter asigna**. Si la tarjeta es nueva se registra; si ya es de otro alumno, se avisa. Con tarjeta: **Bloquear/Desbloquear, Reemplazar** (perdida o dañada; el saldo pasa a la nueva) y **Quitar**. Funciona igual en la web/tableta y en la caja. Captura: [`82-asignar-tarjeta.png`](docs/capturas/v2/82-asignar-tarjeta.png).
- Tutores y alumnos: altas, edición, foto opcional. **Los límites de gasto y productos prohibidos solo los configura el padre/madre/tutor**; la escuela (administrador y cajero) solo los **consulta** (pestaña *Límites y prohibidos (del tutor)*, solo lectura; el servidor responde 403 si lo intentan). Captura: [`85-admin-limites-solo-lectura.png`](docs/capturas/v2/85-admin-limites-solo-lectura.png).
- **Datos del alumno:** el padre/madre/tutor **no** edita el nombre ni el grado/grupo (solo lectura; el servidor responde 403), pero sí sube o quita la foto. Con **Solicitar cambio de datos** (Nombre, Grado y grupo u Otro + valor nuevo + motivo) la solicitud llega a la escuela en **Notificaciones** (insignia con las no leídas). El administrador la **aprueba** (si es nombre o grado se aplica automáticamente) o la **rechaza** con motivo opcional; el tutor ve el estado (pendiente/aprobada/rechazada). Todo queda en la bitácora. Capturas: [`86-tutor-solicitar-cambio.png`](docs/capturas/v2/86-tutor-solicitar-cambio.png), [`87-escuela-notificaciones.png`](docs/capturas/v2/87-escuela-notificaciones.png).
- Usuarios (admin, cajero, tutor); las contraseñas las asigna únicamente el superadministrador (se muestran una sola vez).
- Movimientos con filtros (fechas, tipo, estado, alumno, tarjeta) y exportación a CSV.
- Respaldo de la base de datos: lo descarga el superadministrador desde el servidor.
- En la PWA: **códigos de invitación** por alumno y alta de tutores con contraseña generada (se muestra una vez y se puede enviar por correo/SMS).

**Cajero / punto de venta**
- Lectura de tarjeta: campo con foco automático compatible con lectores USB tipo teclado (Enter envía), captura de “ráfagas” del lector aunque el foco no esté en el campo, lector PC/SC opcional (ACR122U) y Web NFC en Android (PWA).
- Carrito por categorías; los productos prohibidos para ese alumno se marcan en rojo. **F2** cobra, **Esc** limpia.
- Validación **atómica en una transacción** de base de datos: tarjeta activa, alumno activo, producto disponible, producto prohibido, categoría prohibida, límite por compra, límite diario, límite semanal/mensual y saldo suficiente. Si se rechaza, se muestra el motivo (p. ej. *“Producto prohibido por el tutor: Coca-Cola 355 ml”*) y el intento se guarda como movimiento **rechazado**.
- Recargas con montos rápidos.

**Padre / tutor**
- Saldo de cada hijo, gasto de hoy / semana / mes, historial (qué, cuánto, cuándo, y rechazos con motivo).
- Límites: por compra, por día y por semana o mes (cada uno opcional).
- Productos y categorías prohibidas por hijo.
- Bloqueo temporal de la tarjeta (y desbloqueo, salvo que la haya bloqueado la cooperativa).
- Personalizar nombre, grado y foto del hijo.
- En la PWA: autoregistro con código de invitación, vincular otro hijo con código, recuperar contraseña, cerrar sesión en todos los dispositivos.

## 1b. Multi-escuela (varias instituciones en un mismo servidor)

Zuki Company vende el sistema a varias escuelas. Un solo servidor atiende a todas, con **aislamiento estricto**:

| Panel | Quién | Qué ve |
|---|---|---|
| **Superadministrador** (`superadmin`) | Zuki Company | **Escuelas**: lista de escuelas con estado (*Prueba / Activa / Pausada*) y **mensualidad** (días restantes, vencidas resaltadas; §1c), alta/edición, registrar pago, pausar/reactivar, alta del administrador de cada escuela con contraseña generada, usuarios (asignar contraseña, activar/desactivar), estadísticas por escuela (ventas, recargas, tarjetas activas, alumnos, padres vinculados, saldo, y **totales globales**, cajas vinculadas (revocar, hacer principal), **hoja de códigos de invitación** por escuela, nota de plan/cuota. Además **Cuentas, Seguridad y emergencia, Alertas y Bitácora** (§4b). No opera ventas ni ve el panel de ninguna escuela (`/api/rpc` le responde 403). |
| **Escuela** (`admin`, `cajero`) | Personal de cada escuela | Solo su escuela: alumnos, tarjetas, productos/categorías, movimientos, tablero, usuarios (su personal y los tutores con hijos en su escuela), invitaciones y cajas. Un id o UID de otra escuela responde **404 (no encontrado)**. |
| **Padres** (`tutor`) | Padres/tutores | Solo **sus** hijos, aunque estén en **escuelas distintas** (cada hijo muestra su escuela; el catálogo para prohibir productos es el de la escuela de ese hijo). |

- Tablas con `school_id`: `users` (personal; tutores = escuela de alta), `children`, `cards`, `categories` (nombre único **por escuela**), `products`, `transactions`, `devices`, `sync_changes`. Nueva tabla `schools` (nombre, estado, plan/cuota, contacto, equipo principal).
- **UID de tarjeta único en toda la plataforma**: no se puede registrar en la escuela B una tarjeta que ya existe en la A (en la caja se avisa al sincronizar y la tarjeta no se envía).
- **Escuela pausada** (antes “suspendida”; ver §1c): nadie de esa escuela puede iniciar sesión — administrador, cajeros y padres — (403 `ESCUELA_PAUSADA`, “Servicio pausado. Contacte a la administración.”), se cierran sus sesiones abiertas y su caja deja de sincronizar. Un padre con hijos también en otra escuela activa sí sigue entrando.
- **La caja de escritorio pertenece a una escuela**: la del administrador con el que se vincula (el token de equipo lleva la escuela). Todo lo que envía y descarga queda limitado a esa escuela; en la caja solo puede iniciar sesión el personal de esa escuela. Para cambiar una caja de escuela hay que usar una base nueva.
- **Migración automática**: al abrir una base de una versión anterior (una sola escuela), todos los datos pasan a una escuela por defecto *“Mi escuela”* (incluido el equipo principal). Probado con una base real de la versión anterior (`test/fixtures/v1-escritorio.db`).
- **Programar tarjetas** (escritorio, admin): 1) **leer tarjetas en lote** (acercarlas una tras otra; se registran en inventario y se avisan duplicados); 2) **asignarlas a los alumnos sin tarjeta** (propuesta en orden de lectura por grado y nombre, o “Leer” junto a un alumno y acercar su tarjeta); 3) **hoja de códigos para padres**: la caja se sincroniza, pide al servidor un código por alumno (reutiliza los vigentes) y genera un **PDF** o lo **imprime** (un recuadro recortable por alumno con nombre, grado, tarjeta, código y pasos). Ejemplo: `docs/capturas/hoja-codigos-ejemplo.pdf`.

**Datos demo del servidor** (`npm run server` en desarrollo): dos escuelas de ejemplo (*Colegio Morelos (demo)* e *Instituto Valladolid (demo)*), un superadministrador, administradores, cajeros y tutores (María tiene hijos en las dos escuelas). Las **contraseñas de demostración ya no aparecen en las pantallas ni en este repositorio**: están en el archivo privado `cooperativa-nfc-credenciales.md` que se guarda fuera del repositorio. En producción (`NODE_ENV=production`) no se crean datos demo: el superadmin se crea con `SUPERADMIN_USER`/`SUPERADMIN_PASSWORD`.

Capturas: `docs/capturas/w10-superadmin-escritorio.png`, `w13-superadmin-escuela-escritorio.png`, `w08-superadmin-movil.png`, `w09-superadmin-escuela-movil.png`, `w15-superadmin-tablet.png`, `w14-superadmin-hoja-codigos.png`, `w07-tutor-dos-escuelas-movil.png`, `18-programar-leer.png`, `19-programar-asignar.png`, `20-programar-hoja-codigos.png`.

---

## 1c. Mensualidad por escuela (Prueba / Activa / Pausada)

Cada escuela tiene un **estado** y un **periodo pagado** (*fecha inicio* y *fecha fin*, último día con servicio). Todas las fechas se calculan con el calendario de la **Ciudad de México** (`America/Mexico_City`), aunque el servidor esté en otra zona horaria. Código: `src/core/billing.js`; pruebas: `test/billing.test.js`.

| Situación | Qué pasa |
|---|---|
| **Prueba** (escuela nueva) | 30 días desde el alta. Se comporta igual que Activa (avisa, tiene tolerancia y se pausa si no se paga). |
| **Activa** | Periodo pagado. *Registrar pago / renovar* suma **1 mes** al fin. |
| Faltan **3 días o menos** (incluye el día del fin) | Administrador y cajero ven el aviso **“Tu mensualidad vence en X días”**. El superadministrador recibe una alerta. |
| **Tolerancia**: 1.º y 2.º día después del fin | Aviso rojo **“Periodo de tolerancia: quedan X días para realizar el pago”**. Todo sigue funcionando. Alerta *alta* al superadministrador. |
| Termina la tolerancia (3.er día después del fin) | **Pausa automática**: nadie de la escuela entra (admin, cajeros, padres), se cierran sus sesiones, la caja deja de sincronizar y de vender. Mensaje: **“Servicio pausado. Contacte a la administración.”** Los datos **no se borran**. Alerta y bitácora. |
| **Pausada** | Solo el superadministrador la devuelve: **Reactivar** (elige estado y nueva fecha fin; por omisión conserva el fin si sigue vigente o da 7 días) o **Registrar pago** (reactiva como Activa). |

- **Los padres no ven avisos de cobro**; si la escuela se pausa, al entrar ven “Servicio pausado”.
- **Registrar pago / renovar** (superadmin → Escuelas → Administrar → *Mensualidad*): fecha de pago (por omisión hoy), monto y nota opcionales. Si la escuela está al corriente o en tolerancia, el nuevo mes se cuenta **desde el fin anterior** (paga lo atrasado); si estaba pausada o ya había pasado la tolerancia, el mes empieza **hoy**. Una escuela en Prueba pasa a Activa. Queda en el **historial de pagos**.
- **Pausar ahora**, **Reactivar** y **Cambiar estado o fechas** (p. ej. alargar una prueba) están en el mismo recuadro. Todo queda en la **Bitácora** (filtro *Mensualidad*) y genera **Alertas** (por vencer, tolerancia, pausada).
- La revisión se hace al iniciar sesión, en cada petición, en cada sincronización de caja y cada 15 min en el servidor (también al arrancar), así que la pausa ocurre aunque nadie entre.
- **Caja de escritorio**: es la misma app web del servidor, así que el aviso y la pausa se aplican al instante igual que en el navegador (no hay operación sin internet).
- **Migración de escuelas existentes** (automática al arrancar la nueva versión, una sola vez, sin borrar nada): todas pasan a **Prueba con 30 días desde ese día**, para que ninguna se pause de improviso. Las que estaban *suspendidas* quedan **Pausadas**. El superadministrador debe registrar el pago de las que ya pagan (pasan a Activa).

## 2. Instalación para usuarios finales

### Windows 10/11
1. Descargue `ZukiPay-Setup-2.1.0.exe`.
2. Ábralo. Como el instalador **no está firmado** con certificado de código, Windows SmartScreen puede mostrar *“Windows protegió su PC”*: haga clic en **Más información → Ejecutar de todas formas**.
3. Elija la carpeta de instalación y termine. Se crean accesos en el Escritorio y en el menú Inicio.
4. La caja **no guarda datos en la computadora**: todo está en el servidor. Solo guarda la dirección del servidor en `%APPDATA%\Zuki Pay\config.json`. (si existía la configuración de la versión anterior en `%APPDATA%\Cooperativa NFC\` se copia sola).

### macOS (11 o superior)
1. Descargue el archivo para su Mac: `ZukiPay-2.1.0-arm64.dmg/.zip` (Apple Silicon M1/M2/M3/M4) o `-x64` (Intel).
2. Arrastre **Zuki Pay** a *Aplicaciones*.
3. Si la app no está firmada/notarizada, macOS dirá que *“no se puede abrir porque proviene de un desarrollador no identificado”* o que *“está dañada”*. Solución:
   - Clic derecho sobre la app → **Abrir** → **Abrir**; o en *Ajustes del Sistema → Privacidad y seguridad* → **Abrir igualmente**.
   - Si dice “dañada” (común en Apple Silicon con builds hechos fuera de una Mac), en Terminal:
     ```bash
     xattr -cr "/Applications/Zuki Pay.app"
     codesign --force --deep --sign - "/Applications/Zuki Pay.app"
     ```
4. Igual que en Windows, no hay base local (solo `config.json` con la dirección del servidor).

### Primer uso (caja de escritorio)
- Al abrir, la caja se conecta a **https://cooperativa-nfc.onrender.com** y muestra la misma pantalla de entrada que la web. Se entra con la cuenta del servidor (admin o cajero).
- Para usar otro servidor: menú **Archivo → Servidor…** (o el botón *Cambiar servidor…* de la pantalla sin conexión). También con la variable `COOP_SERVER_URL`.
- Sin internet (o con el servidor caído) muestra **“Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.”**, reintenta sola cada 5 s y entra en cuanto el servidor responde. El servidor gratuito de Render puede tardar ~1 min en “despertar”: mientras, se ve *Conectando con el servidor…*.
- Lectores: los **USB tipo teclado** (125 kHz o NFC) funcionan directamente; los **PC/SC** (ACR122U) envían el UID a la app por el puente seguro de la caja (ver `INTEGRACION_NFC.md`).
- **Cajas de la versión 1.x (sin conexión)**: ver §5 antes de actualizar, para subir sus últimas ventas.

### Credenciales de demostración

Por seguridad ya no se muestran en la pantalla de inicio ni se publican aquí. Están en el archivo privado `cooperativa-nfc-credenciales.md` (fuera del repositorio).

Tarjetas demo (UID): `04A1B2C3D4E5F6` (Sofía: Coca-Cola prohibida, límites $50 por compra / $60 diario / $250 semanal), `04B7C8D9E0F1A2` (Diego: categoría Refrescos prohibida, $80 diario), `04C3D4E5F6A7B8` (Valentina: $40 por compra, $600 mensual), `04D9E0F1A2B3C4` (sin asignar).

---

## 3. Desarrollo

### Requisitos
- **Node.js 20 o superior** y npm.
- Para compilar instaladores: ver sección 5.

### Stack
- **Electron 31** + **electron-builder 24** (escritorio), HTML/CSS/JS sin frameworks ni paso de compilación.
- **SQLite vía sql.js** (SQLite compilado a WebAssembly). Se eligió porque **no requiere módulos nativos**: el mismo código corre en Node (pruebas y servidor) y en Electron para Windows/macOS/Linux, y se puede compilar el instalador de Windows desde Linux. La base se guarda completa en disco tras cada transacción (escritura atómica: archivo temporal + renombrar). Adecuado para el volumen de una cooperativa (cientos de tarjetas, miles de movimientos).
- **bcryptjs** (hash de contraseñas), **Express 4** + **jsonwebtoken** (servidor).
- Pruebas con **node:test**.

### Comandos
```bash
npm install          # instala dependencias (descarga Electron)
npm start            # abre la caja de escritorio (cliente en línea; COOP_SERVER_URL=http://localhost:3000 para el servidor local)
npm test             # pruebas automáticas (lógica de negocio, servidor, solo en línea, cuentas, tarjetas)
npm run e2e          # caja de escritorio en línea: sin conexión, recuperación, cobro con lector PC/SC (capturas 80 y 83)
npm run e2e:admin    # editar cuentas, Cuentas en iPad, asignar tarjeta con lector, límites solo lectura (capturas 81, 82, 84, 85)
npm run server       # servidor + PWA en http://localhost:3000 (base en data/servidor.db, con demo)
npm run e2e:web      # prueba de interfaz de la PWA (registro, cambio obligatorio, recuperación)
npm run seed -- demo.db   # crea una base demo en un archivo
```
Variables de la caja: `COOP_SERVER_URL` (servidor), `COOP_RETRY_MS` (reintento, 5000 por defecto).
En Linux sin sandbox de Chrome (contenedores) agregue `-- --no-sandbox`.

### Estructura
```
src/
  core/            Lógica de negocio sin dependencias de Electron (probada con node:test)
    db.js          Esquema SQLite, migraciones, transacciones y guardado atómico (sql.js)
    service.js     Reglas: usuarios, alumnos, tarjetas, productos, límites, compras, recargas, reportes
    auth.js        Autenticación del servidor: JWT, refresh tokens, invitaciones, recuperación, rate limit
    sync-client.js Sincronización de cajas 1.x (solo se usa en pruebas del modo LEGACY_SYNC)
    sync-server.js Sincronización lado servidor; el envío (push) está desactivado salvo LEGACY_SYNC=1
    api.js         Enrutador (lista blanca de métodos) usado por IPC y por el servidor
    seed.js        Datos de demostración
  main/            Caja de escritorio (cliente en línea)
    main.js        Ventana que carga la app del servidor; aviso sin conexión y reintento; menú Servidor…
    online.js      Dirección del servidor (predeterminada Render), comprobación /api/health, navegación permitida
    preload.js     Puente seguro (window.coopDesktop: lector PC/SC; cambio de servidor solo en páginas locales)
    nfc.js         Lector PC/SC opcional (nfc-pcsc) → envía UID a la página por IPC
    remote-auth.js (sin uso desde 2.0; se conserva por referencia)
  desktop-ui/      Páginas locales de la caja: Conectando…, Sin conexión, Servidor…
  renderer/        Interfaz (styles.css, app.js) — la sirve el servidor para web, tableta, celular y caja
server/
  app.js, index.js Servidor Express (API REST + PWA)
  public/          index.html, coop-web.js (adaptador REST), manifest, service worker, íconos
test/              Pruebas node:test
scripts/           seed-cli, e2e (caja en línea), e2e-web, e2e-admin y e2e-mensualidad (PWA)
examples/          Script para probar un lector PC/SC
build/             Íconos para los instaladores
docs/capturas/     Capturas de pantalla
```

### Modelo de datos
`schools` (estado prueba/activa/pausada, periodo `period_start`/`period_end`, `paused_at`/`pause_reason`, plan, contacto, equipo principal), `school_payments` (historial de pagos de mensualidad) y `school_id` en las tablas de cada escuela (ver 1b); `users` (rol superadmin/admin/cajero/tutor, `must_change_password`, `token_version`), `children` (tutor opcional hasta vincularse), `cards` (`uid` único, `child_id`, estado activa/bloqueada/perdida/sin_asignar, `balance_cents` entero ≥ 0), `categories`, `products` (`price_cents`), `transactions` (tipo compra/recarga/ajuste, estado aprobado/rechazado, motivo, monto, saldo después, tarjeta, alumno, usuario que procesó, fecha/hora local), `transaction_items`, `limits` (por compra, diario, periodo semana/mes; cada uno puede ser nulo), `prohibited_products`, `prohibited_categories`, y para el servidor `refresh_tokens`, `password_resets`, `invitations`.

---

## 4. Cuentas, inicio de sesión y seguridad

### Caja de escritorio
- No tiene usuarios ni base local: se entra con la cuenta **del servidor** (misma pantalla que la web) y la sesión se guarda como en el navegador (refresh token). Cada operación la valida el servidor.
- **Solo el superadministrador cambia contraseñas** (ver §4b).

### Servidor / PWA
- **Altas de tutores**: (1) el admin crea la cuenta con correo o teléfono y el servidor genera una **contraseña** (se muestra una sola vez, con botón para copiar, y se envía por el *mailer*). (2) El admin genera un **código de invitación por alumno** (`COOP-XXXX-XXXX`, vence en 30 días, un solo uso; generar otro invalida el anterior) que se entrega con la tarjeta; el padre se **autoregistra** en la PWA y queda vinculado. Un tutor ya registrado puede vincular más hijos con otro código. Si el alumno ya tenía tutor, el código transfiere la vinculación.
- Inicio de sesión con usuario, **correo o teléfono** (10 dígitos).
- **JWT de acceso** (HS256, 15 min) + **refresh token** opaco (30 días, guardado como hash SHA-256, **rotación** en cada uso y **detección de reutilización**: si se usa uno ya rotado, se revoca toda la familia).
- **Límite de intentos**: 5 fallos por cuenta en 15 min y 30 por IP ⇒ HTTP 429. Además, **bloqueo persistente**: la cuenta del superadmin se bloquea 15 min tras 5 contraseñas incorrectas seguidas y las demás tras 10; se genera una alerta.
- **Cambio obligatorio de contraseña** (solo superadmin con `SUPERADMIN_FORCE_CHANGE=1`): con `must_change_password` solo se permiten `/api/auth/me`, `/api/auth/change-password` y `/api/auth/logout*`; el resto responde 403 `DEBE_CAMBIAR_PASSWORD`.
- **Cerrar sesión** (revoca el refresh token) y **cerrar sesión en todos los dispositivos** (revoca todos e incrementa `token_version`, lo que invalida de inmediato los JWT emitidos). Cambiar o restablecer la contraseña, o desactivar al usuario, también invalida sesiones.
- **Recuperación de contraseña por correo: desactivada** (`/api/auth/forgot` y `/api/auth/reset` responden 403). Quien olvide su contraseña pide una nueva al superadministrador (*Cuentas → Contraseña*). El código sigue disponible con `createServer({ allowSelfReset: true })`.
- **Envío real de correo/SMS**: el *mailer* es enchufable (`src/core/auth.js → consoleMailer`). En desarrollo **solo imprime el mensaje en la consola del servidor**. Para producción implemente un objeto `{ send({ to, channel, subject, text }) }` con un proveedor como **Resend**, **SendGrid** o **Amazon SES** (correo) o **Twilio** (SMS/WhatsApp) y páselo en `createServer({ mailer })`.
- Roles **admin / cajero / tutor** verificados en cada endpoint (middleware + validación en el servicio; el tutor solo ve a sus hijos).
- Encabezados `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`; CSP estricta en la PWA. El refresh token se guarda en `localStorage` (mitigado por la CSP sin scripts externos); ver `PENDIENTES.md` para migrarlo a cookie `HttpOnly`.

### Variables de entorno del servidor
| Variable | Descripción |
|---|---|
| `PORT` | Puerto (3000) |
| `DB_PATH` | Archivo SQLite (por defecto `data/servidor.db`). **Debe estar en disco persistente.** |
| `JWT_SECRET` | **Obligatorio en producción** (≥ 32 caracteres aleatorios). En desarrollo se genera y guarda en la base. |
| `APP_URL` | URL pública, usada en los enlaces de recuperación |
| `NODE_ENV=production` | Desactiva datos demo y exige `JWT_SECRET` |
| `SEED=1/0` | Fuerza o desactiva los datos demo |
| `SUPERADMIN_USER`, `SUPERADMIN_PASSWORD` | Crea la cuenta del **superadministrador** (Zuki Company) **solo si no existe** (contraseña ≥ 8). Ya no se obliga a cambiarla en cada reinicio. Por defecto el usuario es `zuki`. |
| `SUPERADMIN_FORCE_CHANGE=1` | Opcional: obliga al superadmin recién creado a cambiar su contraseña al entrar. |
| `SUPERADMIN_RESET_PASSWORD` | **Recuperación de emergencia** (ver §4b): al arrancar, pone esta contraseña al superadmin, lo reactiva y desbloquea. Se aplica una sola vez por valor; quítela después de entrar. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Guardado permanente **gratis** en Turso (ver §8). |
| `BACKUP_DIR` | Carpeta de copias diarias cuando la base está en disco permanente (por defecto junto a la base; se guardan 14). |
| `TZ` | Zona horaria (por defecto `America/Mexico_City`); se usa para el horario escolar y los cortes por día. |
| `ADMIN_USER`, `ADMIN_PASSWORD`, `SCHOOL_NAME` | Opcional: crea una primera escuela con su administrador. Normalmente las escuelas se crean desde el panel del superadmin. |
| `TRUST_PROXY=1` | Detrás de un proxy (Render, Railway, Nginx) para que el límite por IP use la IP real |
| `LEGACY_SYNC=1` | **Solo para migrar** cajas 1.x: permite unos minutos el envío de ventas sin conexión de una caja vieja (§5). Normalmente **no** se define. |

### 4b. Seguridad y emergencia (superadministrador)

Menú del superadmin: **Escuelas · Cuentas · Seguridad y emergencia · Alertas · Bitácora · Mi cuenta**.

- **Política de contraseñas**: solo el superadmin asigna contraseñas (*Cuentas → 🔑 Contraseña*). Se muestra **una sola vez** con botón *Copiar* y no se guarda en texto en ningún lado (bcrypt); asignarla cierra las sesiones de esa persona. Admin, cajero y tutor no tienen pantalla ni API para cambiarla (`/api/auth/change-password` ⇒ 403 para ellos). El superadmin cambia la suya en *Mi cuenta* (mín. 10 caracteres).
- **Cuentas**: todas las cuentas de todas las escuelas con jerarquía, escuela, estado (activa/desactivada/bloqueada por intentos), último acceso (con IP) y fecha de alta; activar/desactivar y desbloquear.
- **✏️ Editar cuenta** (botón en cada cuenta): nombre, usuario, correo, teléfono, **jerarquía** (Administrador / Cajero / Padre-tutor), **escuela** y, para padres/tutores, sus **alumnos vinculados** (buscar y *Vincular* en cualquier escuela, o *Quitar*). Usuario, correo y teléfono deben ser únicos. Si cambia usuario, jerarquía o escuela, se cierran sus sesiones. Todo cambio queda en la **Bitácora** (`cuenta_editada`, con antes/ahora y alumnos vinculados/desvinculados). En la cuenta del superadministrador solo se editan nombre, correo y teléfono (usuario y jerarquía protegidos). API: `getAccount`, `updateAccount`, `searchChildren` en `/api/super/:method`. Captura: [`81-super-editar-cuenta.png`](docs/capturas/v2/81-super-editar-cuenta.png).
- En **tableta vertical (iPad) y pantallas angostas** la lista de Cuentas (y la de Tarjetas) se muestra como **tarjetas**, sin desbordarse y con los botones visibles: [`84-super-cuentas-ipad.png`](docs/capturas/v2/84-super-cuentas-ipad.png).
- **Superadmin protegido**: no se puede borrar, degradar ni desactivar (triggers en SQLite además de las validaciones).
- **Congelar recargas** (global o por escuela), **congelar ventas** y **solo lectura** por escuela. Las cajas de escritorio vinculadas reciben estas banderas en cada sincronización y bloquean localmente.
- **Bloquear administradores** de una escuela (desactiva y cierra sus sesiones) y **cerrar sesiones** por escuela o de todos (incrementa `token_version`, lo que invalida los JWT al instante).
- **ALERTA ROJA**: botón rojo con confirmación escrita (`ALERTA ROJA`). Pone todo en solo lectura, cierra todas las sesiones excepto la del superadmin y rechaza cualquier inicio de sesión que no sea del superadmin. *Desbloquear el sistema* lo revierte.
- **Límite diario de recargas** por escuela, monto de "recarga grande" y horario escolar configurables (*Límites y horario*).
- **Alertas automáticas**: recarga grande (por defecto ≥ $1,000), 3+ recargas a la misma tarjeta en 10 min, 10+ recargas del mismo usuario en 10 min, recargas fuera de horario o en fin de semana, posible **auto-recarga** (quien recarga es el mismo tutor del alumno: misma cuenta, correo, teléfono o nombre), límite diario superado, borrados, ráfagas de contraseñas incorrectas y bloqueos de cuenta.
- **Revisar recargas**: marcar como sospechosa o **revertir** (crea un ajuste negativo; si la escuela usa caja de escritorio, que es dueña de los saldos, se bloquea la tarjeta y se marca la recarga para que la escuela haga el ajuste en la caja).
- **Bitácora** (no se borra desde la app): quién, cuándo, IP y qué (recargas, borrados, contraseñas, roles/cuentas, accesos, acciones de emergencia), con filtros por fecha, tipo, escuela y texto.
- **Borrado suave**: los productos borrados van a la **Papelera** y se pueden restaurar.
- **Respaldo descargable**: *Seguridad → Descargar respaldo* (`GET /api/super-backup`, archivo `.db` de SQLite).

**Recuperación de emergencia del superadmin** (si olvidó la contraseña o la cuenta quedó bloqueada):
1. En Render → servicio → *Environment*, agregue `SUPERADMIN_RESET_PASSWORD` con una contraseña nueva (≥ 10 caracteres) y guarde (Render reinicia el servicio).
2. Entre con su usuario y esa contraseña. Queda registrado en la Bitácora y aparece una alerta.
3. **Borre la variable** `SUPERADMIN_RESET_PASSWORD` de Render (si la deja, no se vuelve a aplicar con el mismo valor, pero no conviene dejarla escrita).

---

## 5. Cajas de la versión 1.x (sincronización sin conexión) — RETIRADA

Desde la versión 2.0 **no hay sincronización**: la caja es un cliente en línea y el servidor es la única fuente de verdad.

- El servidor **rechaza** el envío de datos de cajas viejas: `POST /api/sync/push` responde **410 `VERSION_OBSOLETA`** (*“Esta versión de la caja ya no se usa: el sistema ahora funciona solo con internet…”*). Así una caja vieja no puede sobrescribir saldos registrados en línea. Las demás rutas `/api/sync/*` (vincular, estado, pull) siguen respondiendo para no romper cajas viejas, pero no son necesarias.
- Ya no existe el bloqueo `SOLO_ESCRITORIO`: con o sin caja vieja vinculada, ventas, recargas, tarjetas, alumnos y productos se registran desde la web/tableta y desde la caja nueva.
- **Cómo cambiar una escuela que usaba la caja 1.x** (hacerlo en este orden):
  1. **Antes de desplegar** la versión nueva del servidor, abra la caja vieja con internet y presione **“Sincronizar ahora”** hasta que diga *Sincronizado* y *0 pendientes*. (Si el servidor nuevo ya está desplegado, ponga temporalmente `LEGACY_SYNC=1` en Render, sincronice la caja vieja y **quite la variable**.)
  2. Desinstale la caja vieja e instale `ZukiPay-Setup-2.1.0.exe`. Entre con la cuenta del servidor.
  3. Si alguna escuela no tenía servidor (solo caja local), sus datos locales **no se migran solos**: hay que vincularla una vez con la caja 1.x y `LEGACY_SYNC=1` para subirlos.
- `LEGACY_SYNC=1` reactiva el comportamiento anterior (incluido el bloqueo `SOLO_ESCRITORIO` mientras exista una caja principal). Úselo solo unos minutos para la migración.

## 6. API

### Interfaz (web, tableta y caja)
La interfaz llama `window.coop.call(metodo, args)` (`server/public/coop-web.js`), que usa la API REST. Respuesta: `{ ok: true, data }` o `{ ok: false, error, code }`. Sin conexión responde `{ ok:false, code:'SIN_CONEXION' }` **sin enviar nada** y muestra el aviso a pantalla completa. Las respuestas de `/api/*` llevan `Cache-Control: no-store` y el *service worker* solo guarda la interfaz estática (nunca datos).

### Servidor (REST, JSON)
Autenticación: `Authorization: Bearer <access_token>`. Errores: `{ ok:false, error, code }` con HTTP 400 `VALIDACION`, 401 `NO_AUTENTICADO`, 403 `PROHIBIDO`/`DEBE_CAMBIAR_PASSWORD`, 404, 409 `DUPLICADO`, 429 `LIMITE_INTENTOS`.

| Método y ruta | Rol | Cuerpo → respuesta |
|---|---|---|
| `GET /api/health` | público | estado |
| `POST /api/auth/login` | público | `{identifier, password}` → `{access_token, refresh_token, expires_in, user, must_change_password}` |
| `POST /api/auth/refresh` | público | `{refresh_token}` → tokens nuevos (rotación) |
| `POST /api/auth/logout` | público | `{refresh_token}` |
| `POST /api/auth/logout-all` | autenticado | revoca todas las sesiones |
| `GET /api/auth/me` | autenticado | usuario |
| `POST /api/auth/change-password` | autenticado | `{current, next}` → tokens nuevos |
| `POST /api/auth/forgot` | público | `{identifier}` → mensaje genérico |
| `POST /api/auth/reset` | público | `{token, password}` |
| `POST /api/auth/register` | público | `{code, full_name, email?, phone?, password}` (mín. 8) → tokens |
| `POST /api/auth/redeem` | tutor | `{code}` → vincula otro hijo |
| `POST /api/admin/tutors` | admin | `{full_name, email?, phone?, child_ids?}` → `{user, temporary_password}` |
| `POST /api/admin/invitations` | admin | `{child_id}` → `{code, expires_at}` |
| `GET /api/admin/invitations` | admin | lista con estado pendiente/usado/vencido |
| `POST /api/rpc/<metodo>` | según método | métodos de negocio (tabla siguiente) |
| `POST /api/super/<metodo>` | superadmin | `overview`, `createSchool {name, status, plan_note, contact_*, admin_username, admin_full_name}` → `{school, admin:{user, temporary_password}}`, `updateSchool {id, ...}`, `schoolDetail {id}`, `createStaff {school_id, role, username, full_name}`, `resetStaffPassword {user_id}`, `setStaffActive {user_id, active}`, `revokeDevice`/`setPrimaryDevice {school_id, device_id}`, `listChildren {school_id}`, `generateInvitations {school_id, child_ids?}` |

Métodos de negocio (IPC y `/api/rpc/<metodo>`; montos en **centavos**):

| Método | Roles | Argumentos |
|---|---|---|
| `dashboard` | admin | — |
| `listUsers` | admin, cajero | `{role?}` |
| `createUser` / `updateUser` | admin | `{role, username?, password, full_name, email?, phone?, must_change_password?}` / `{id, ...}` |
| `changePassword` | todos (en el servidor use `/api/auth/change-password`) | `{current, next}` |
| `listChildren` | todos (tutor: solo los suyos) | — |
| `createChild` | admin | `{full_name, grade?, tutor_id?, photo?}` |
| `updateChild` | admin, tutor (propio: nombre/grado/foto) | `{id, ...}` |
| `childSummary` | admin, cajero, tutor propio | `{child_id}` |
| `listCategories` / `createCategory` | todos / admin | `{child_id?}` (tutor: catálogo de la escuela de ese hijo) / `{name}` |
| `listProducts` | todos | `{onlyActive?, child_id?}` |
| `createProduct` / `updateProduct` / `deleteProduct` | admin | `{name, category_id, price_cents, active}` / `{id,...}` / `{id}` |
| `listCards`, `lookupCard` | admin, cajero | — / `{uid}` |
| `registerCard` | admin | `{uid, child_id?}` |
| `assignCard` | admin | `{card_id, child_id}` |
| `setCardStatus` | admin, tutor propio | `{card_id, status: 'activa'|'bloqueada'}` |
| `reportLostAndReplace` | admin | `{card_id, new_uid?}` |
| `getLimits` / `setLimits` | admin, tutor propio (cajero solo lectura) | `{child_id, per_transaction_cents?, per_day_cents?, period_type?: 'semana'|'mes', per_period_cents?}` |
| `getProhibitions` / `setProhibitions` | admin, tutor propio | `{child_id, product_ids?, category_ids?}` |
| `recharge` | admin, cajero | `{uid, amount_cents, note?}` (máx. $5,000) |
| `adjust` | admin | `{uid, amount_cents (±), note}` |
| `purchase` | admin, cajero | `{uid, items:[{product_id, qty}]}` → `{ok, reason?, total_cents, balance_cents}` |
| `listMovements` | todos (tutor: sus hijos) | `{from?, to?, type?, status?, child_id?, uid?, limit?}` |

Ejemplo:
```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"cajero","password":"cajero123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.access_token')
curl -s -X POST localhost:3000/api/rpc/purchase -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"uid":"04A1B2C3D4E5F6","items":[{"product_id":5,"qty":1}]}'
# {"ok":true,"data":{"ok":false,"reason":"Producto prohibido por el tutor: Coca-Cola 355 ml",...}}
```

---

## 7. Compilar instaladores

Artefactos en `dist/`. Los instaladores **no están firmados** (ver abajo).

```bash
npm install
npm run dist:win     # Windows x64 → dist/ZukiPay-Setup-2.1.0.exe (NSIS, en español)
npm run dist:mac     # macOS → dist/*.dmg y *.zip para x64 y arm64 (requiere una Mac)
npm run dist:linux   # Linux → dist/ZukiPay-2.1.0-x86_64.AppImage (pruebas)
```
- **Windows desde Linux**: requiere Wine con soporte de 32 bits (Debian/Ubuntu: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386`). Desde Windows no se necesita nada extra.
- **macOS**: el `.dmg` solo se genera en una Mac (usa `hdiutil`). En una Mac con Xcode Command Line Tools (`xcode-select --install`):
  ```bash
  git clone … && cd cooperativa-nfc && npm install
  npm run dist:mac
  ```
  Sin certificado, electron-builder firma *ad-hoc* y el usuario verá la advertencia de Gatekeeper.
- Los `.zip` de macOS incluidos en `dist/` se generaron desde Linux **sin firma y sin probar en una Mac**; en Apple Silicon probablemente requieran el comando `codesign --sign -` de la sección 2. Para distribución, genere los `.dmg` en una Mac.
- **Firma y notarización (recomendado para distribución)**:
  - macOS: cuenta Apple Developer (99 USD/año), certificado *Developer ID Application*. Exportar `CSC_LINK` (ruta .p12) y `CSC_KEY_PASSWORD`, y para notarizar `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; agregar `"notarize": true` en `build.mac` (`hardenedRuntime` ya está activado).
  - Windows: certificado de firma de código (OV o EV; EV elimina la advertencia de SmartScreen de inmediato, OV la reduce conforme gana reputación). Exportar `CSC_LINK` y `CSC_KEY_PASSWORD` (o `WIN_CSC_LINK`) antes de `npm run dist:win`.

---

## 8. Desplegar el servidor y guardar los datos

El servidor es Node + SQLite (sql.js, en memoria con escritura a archivo). Al arrancar indica el modo de guardado en `/api/health` (`persistence`) y en *Seguridad → Dónde se guardan los datos*:

| Modo | Cómo se activa | Costo | Notas |
|---|---|---|---|
| **temporal** | `DB_PATH` en `/tmp` sin Turso (situación actual en Render gratis) | 0 | **Se pierde todo** en cada reinicio o despliegue. Solo para demostraciones. |
| **turso** | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | 0 (plan gratis de Turso) | Al arrancar descarga la última copia; tras cada cambio sube una copia comprimida (en ≤ 3–15 s) y al apagarse. Conserva la copia anterior. Riesgo: si el servidor se cae en esos segundos, se pierde lo último. |
| **disco** | `DB_PATH=/var/data/servidor.db` con un *Persistent Disk* | Render Starter 7 USD/mes + disco ~0.25 USD/GB/mes | Lo más robusto. Copia diaria automática (14 días) en `BACKUP_DIR`. Sin "dormirse". |

**Recomendación**: para una prueba piloto, Turso gratis. Para una escuela cobrando en serio, Render **Starter + disco 1 GB** (≈ 7.25 USD/mes): el plan gratis de Render se **duerme tras 15 min sin visitas** (la primera carga tarda ~1 min) y eso no sirve para una caja.

**Turso (gratis)**:
1. Cree una cuenta en https://turso.tech (con GitHub) y una base (*Create database*, región cercana, p. ej. `aws-us-east-1` o `dfw`).
2. En la base: copie la **URL** (`libsql://NOMBRE-USUARIO.turso.io`) y genere un **token** (*Generate token*, permiso lectura y escritura, sin vencimiento).
3. En Render → servicio → *Environment*: agregue `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`. Deje `DB_PATH=/tmp/servidor.db`. Guarde: Render reinicia y `/api/health` dirá `"persistence":"turso"`.
4. La primera vez la base empieza vacía (se crea el superadmin con `SUPERADMIN_PASSWORD`); desde ahí los datos sobreviven a reinicios.

**Render con disco (7 USD/mes)**:
1. Render → servicio → *Settings* → *Instance type* → **Starter**.
2. *Disks* → *Add disk*: Mount path `/var/data`, tamaño 1 GB.
3. *Environment*: `DB_PATH=/var/data/servidor.db` (y quite las variables de Turso si las tenía). Guarde.

Otras opciones: **VPS** (DigitalOcean, Hetzner, Lightsail; ~5 USD/mes) con Node 20, `npm ci --omit=dev`, `systemd`/`pm2`, Caddy/Nginx con HTTPS y `TRUST_PROXY=1`; **Railway / Fly.io** con el `Dockerfile` y un volumen. Netlify/Vercel no sirven para el backend. HTTPS es obligatorio. Use una sola instancia (SQLite + límites en memoria).

---

## 9. Pruebas realizadas

- **Versión 2.0 (solo en línea)**: `npm test` → **70 pruebas, 70 aprobadas**. Nuevas: **`test/online-only.test.js`** (11): el servidor rechaza el envío de cajas viejas (410), se cobra y recarga en línea aunque hubiera una caja vieja principal, API sin caché, hoja de códigos en línea, el adaptador web bloquea ventas/recargas sin internet (sin enviar nada ni guardarlas), se recupera al volver la conexión, el *service worker* nunca sirve datos, dirección del servidor de la caja y detección de servidor caído. **`test/admin-features.test.js`** (5): límites/prohibidos solo del tutor (403 para admin/cajero), edición de cuentas por el superadmin (usuario/correo/teléfono únicos, bitácora, cuenta protegida, alumnos del tutor) y asignación de tarjetas por UID sin duplicados. `npm run e2e` (caja en línea), `npm run e2e:admin`, `npm run e2e:web` y `npm run e2e:mensualidad`: OK.
- Versión 1.x: `npm test`: **54 pruebas, 54 aprobadas**. **`test/billing.test.js`** (8 pruebas, mensualidad): fechas en hora de CDMX, aviso/tolerancia/pausa automática, sesiones cerradas y nadie de la escuela entra (padre con otra escuela activa sí), datos intactos, pago/renovación e historial, pausar/reactivar, revisión periódica, caja de escritorio marcada como pausada y migración de escuelas existentes. Incluye las anteriores (multi-escuela, límites, prohibidos, tarjetas, autenticación, refresh tokens, invitaciones, sincronización) y **`test/security.test.js`** (10 pruebas): cuentas y contraseñas solo por superadmin, superadmin imborrable/no degradable, bloqueo por intentos y recuperación por variable de entorno, congelar recargas/ventas, solo lectura y límite diario, bloquear administradores y cerrar sesiones (JWT invalidados), ALERTA ROJA (logins bloqueados salvo superadmin), alertas de anomalías y reversión, papelera y respaldo, persistencia en Turso con un servidor falso, y caja de escritorio que recibe las banderas y genera alertas al sincronizar.
- `npm run e2e:mensualidad`: panel de mensualidad del superadmin, avisos de vencimiento y tolerancia para admin/cajero (no para padres) y mensaje de servicio pausado; capturas `docs/capturas/v2/70-…77-*.png`.
- `npm run e2e:web` y `npm run e2e` (con `xvfb-run` en Linux): recorren todas las pantallas por rol con el diseño v2 y guardan capturas en `docs/capturas/v2/`; verifican que el inicio de sesión no muestra credenciales, que el superadmin asigna una contraseña y el cajero entra con ella, ALERTA ROJA y desbloqueo, que admin/cajero no pueden cambiar contraseñas, ventas aprobadas/rechazadas, lector USB tipo teclado, sincronización con un servidor real, programar tarjetas y registro con invitación.

Más: integración con lectores en `INTEGRACION_NFC.md`; mejoras futuras en `PENDIENTES.md`.

## v2.1 — Notificaciones para padres, Reportes e Inventario

- **Notificaciones (padres, PWA):** en "Mis hijos" → **Activar notificaciones**. Avisos de cada compra (productos, monto y saldo restante), compras rechazadas y saldo bajo (umbral configurable, $50 por defecto, un aviso por cada vez que baja). Cada tipo se puede apagar. En iPhone/iPad solo funciona con la app agregada a la pantalla de inicio (iOS 16.4+); la app lo indica. Las suscripciones vencidas (404/410) se borran solas.
  Variables de entorno: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:...`). Sin ellas, el servidor genera llaves y las guarda en la base (siguen funcionando).
- **Reportes (administrador):** Hoy / Esta semana / Este mes / Personalizado; ventas, número de ventas, ticket promedio, recargas, ventas por día, más vendidos, por cajero y rechazadas. **Descargar PDF**, **Descargar imagen** (PNG) y Excel (CSV). Botón **Corte del día**. El cajero solo ve su **Corte del día**.
- **Inventario:** existencias (piezas) y stock mínimo opcionales por producto (en blanco = sin control); se descuentan en la misma transacción de la venta y regresan al **cancelar una venta** (Movimientos → Cancelar venta). Opción "No vender si no hay existencias". **+ Entrada** con bitácora ("Movimientos de inventario"). Al llegar al mínimo se crea un aviso en **Notificaciones** (con insignia) y el filtro **Por agotarse** en Productos.
- Migración: solo tablas y columnas nuevas (no se borra ni reescribe nada). Pruebas: `npm test`, `xvfb-run npx electron scripts/e2e-v21.js` (capturas 90–94).

## Marca Zuki Pay (v2.1.0)

- El sistema se llama **Zuki Pay** (antes "Cooperativa NFC"). Identificadores internos (paquete `cooperativa-nfc`, base de datos, URL de Render, repositorio) no cambian.
- Logo opción J (navy + menta/cian). Íconos regenerados con `python3 scripts/gen-icons-zukipay.py` (PWA, favicon, `build/icon.png` 1024 y `build/icon.ico` 16–256).
- El instalador y `Zuki Pay.exe` llevan el ícono (verificado con `wrestool -x -t 14`). Capturas: `docs/capturas/v2/99-zukipay-login.png`, `99b-zukipay-panel.png` (`npm run e2e:zukipay`).
