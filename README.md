# Cooperativa NFC — Tiendita escolar con tarjetas NFC

Sistema para la cooperativa escolar de **Zuki Company (Morelia, Michoacán)**. Cada alumno tiene una tarjeta NFC; los padres/tutores recargan saldo en la cooperativa, los niños pagan con la tarjeta y **cada movimiento queda registrado** (incluidos los intentos rechazados). Montos en **pesos mexicanos (MXN)**, guardados internamente en centavos (enteros).

Consta de dos piezas que comparten la misma lógica de negocio (`src/core`):

| Pieza | Para quién | Dónde corre | Estado |
|---|---|---|---|
| **App de escritorio** (Electron) | Administrador y cajero en la cooperativa (también tutores en el mismo equipo) | Windows / macOS (Linux para pruebas). Funciona **sin internet** | Completa |
| **Servidor + app web (PWA)** (opcional) | Padres desde casa/celular/tableta; admin desde navegador | VPS, Render, Railway… con disco persistente | Completo (API, cuentas, PWA) |
| **Sincronización** escritorio ↔ servidor | Automática | Cada 45 s + unos segundos después de cada venta + botón “Sincronizar ahora” | Completa (ver sección 5) |
| **Multi-escuela** + panel de **superadministrador** | Zuki Company (dueña de la plataforma) | En el servidor / PWA | Completo (ver sección 1b) |

> **Guía paso a paso para poner en marcha una escuela (lenguaje sencillo): [`GUIA_ARRANQUE_ESCUELA.md`](GUIA_ARRANQUE_ESCUELA.md).**

Forma de operar recomendada: la **caja de escritorio** vende y recarga (funciona sin internet) y se sincroniza con el **servidor**, donde los padres consultan saldo/historial y configuran límites, prohibidos y bloqueos desde su celular. También puede operarse solo con el escritorio (sin servidor) o solo con el servidor (sin caja de escritorio vinculada).

---

## 1. Funciones

**Administrador**
- Panel: ventas del día / semana / mes, recargas, tarjetas activas, saldo total en tarjetas, rechazos del día, productos más vendidos y gráfica de ventas por día (SVG, sin internet).
- Productos: alta, edición, precio, categoría, activar/desactivar, eliminar (si tiene ventas solo se desactiva). Categorías.
- Tarjetas: registrar UID (con lector o a mano), asignar a alumno, bloquear/activar, **reportar perdida y transferir saldo** a una tarjeta nueva, ajustes de saldo con motivo.
- Tutores y alumnos: altas, edición, foto opcional, límites y prohibiciones de cualquier alumno.
- Usuarios (admin, cajero, tutor), contraseña temporal con **cambio obligatorio** al primer inicio.
- Movimientos con filtros (fechas, tipo, estado, alumno, tarjeta) y exportación a CSV.
- Respaldo de la base de datos (escritorio).
- En la PWA: **códigos de invitación** por alumno y alta de tutores con contraseña temporal enviada por correo/SMS.

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
| **Superadministrador** (`superadmin`) | Zuki Company | **Instituciones**: lista de escuelas con estado (*activa / en prueba / suspendida*), alta/edición/suspensión, alta del administrador de cada escuela con **contraseña temporal**, usuarios (restablecer contraseña, activar/desactivar), estadísticas por escuela (ventas, recargas, tarjetas activas, alumnos, padres vinculados, saldo, **última sincronización de su caja**) y **totales globales**, cajas vinculadas (revocar, hacer principal), **hoja de códigos de invitación** por escuela, nota de plan/cuota. No opera ventas ni ve el panel de ninguna escuela (`/api/rpc` le responde 403). |
| **Escuela** (`admin`, `cajero`) | Personal de cada escuela | Solo su escuela: alumnos, tarjetas, productos/categorías, movimientos, tablero, usuarios (su personal y los tutores con hijos en su escuela), invitaciones y cajas. Un id o UID de otra escuela responde **404 (no encontrado)**. |
| **Padres** (`tutor`) | Padres/tutores | Solo **sus** hijos, aunque estén en **escuelas distintas** (cada hijo muestra su escuela; el catálogo para prohibir productos es el de la escuela de ese hijo). |

- Tablas con `school_id`: `users` (personal; tutores = escuela de alta), `children`, `cards`, `categories` (nombre único **por escuela**), `products`, `transactions`, `devices`, `sync_changes`. Nueva tabla `schools` (nombre, estado, plan/cuota, contacto, equipo principal).
- **UID de tarjeta único en toda la plataforma**: no se puede registrar en la escuela B una tarjeta que ya existe en la A (en la caja se avisa al sincronizar y la tarjeta no se envía).
- **Escuela suspendida**: su personal no puede iniciar sesión (403 `ESCUELA_SUSPENDIDA`), se cierran sus sesiones abiertas y su caja deja de sincronizar; los padres siguen consultando saldo e historial.
- **La caja de escritorio pertenece a una escuela**: la del administrador con el que se vincula (el token de equipo lleva la escuela). Todo lo que envía y descarga queda limitado a esa escuela; en la caja solo puede iniciar sesión el personal de esa escuela. Para cambiar una caja de escuela hay que usar una base nueva.
- **Migración automática**: al abrir una base de una versión anterior (una sola escuela), todos los datos pasan a una escuela por defecto *“Mi escuela”* (incluido el equipo principal). Probado con una base real de la versión anterior (`test/fixtures/v1-escritorio.db`).
- **Programar tarjetas** (escritorio, admin): 1) **leer tarjetas en lote** (acercarlas una tras otra; se registran en inventario y se avisan duplicados); 2) **asignarlas a los alumnos sin tarjeta** (propuesta en orden de lectura por grado y nombre, o “Leer” junto a un alumno y acercar su tarjeta); 3) **hoja de códigos para padres**: la caja se sincroniza, pide al servidor un código por alumno (reutiliza los vigentes) y genera un **PDF** o lo **imprime** (un recuadro recortable por alumno con nombre, grado, tarjeta, código y pasos). Ejemplo: `docs/capturas/hoja-codigos-ejemplo.pdf`.

**Datos demo del servidor** (`npm run server` en desarrollo): superadmin **`zuki` / `zuki123`**; escuela 1 *Colegio Morelos (demo)* con `admin`/`admin123`, `cajero`/`cajero123`, tutores `maria`, `juan` (los mismos datos del escritorio); escuela 2 *Instituto Valladolid (demo)* (en prueba) con `admin2`/`admin123`, `cajero2`/`cajero123`, alumnos Lucía (hija de **María**, para ver un tutor con hijos en dos escuelas) y Mateo, tarjetas `05A1A1A1A1A1A1`, `05B2B2B2B2B2B2`, `05C3C3C3C3C3C3`. En producción el superadmin se crea con `SUPERADMIN_USER`/`SUPERADMIN_PASSWORD` y **debe cambiar la contraseña** al entrar.

Capturas: `docs/capturas/w10-superadmin-escritorio.png`, `w13-superadmin-escuela-escritorio.png`, `w08-superadmin-movil.png`, `w09-superadmin-escuela-movil.png`, `w15-superadmin-tablet.png`, `w14-superadmin-hoja-codigos.png`, `w07-tutor-dos-escuelas-movil.png`, `18-programar-leer.png`, `19-programar-asignar.png`, `20-programar-hoja-codigos.png`.

---

## 2. Instalación para usuarios finales

### Windows 10/11
1. Descargue `CooperativaNFC-Setup-1.0.0.exe`.
2. Ábralo. Como el instalador **no está firmado** con certificado de código, Windows SmartScreen puede mostrar *“Windows protegió su PC”*: haga clic en **Más información → Ejecutar de todas formas**.
3. Elija la carpeta de instalación y termine. Se crean accesos en el Escritorio y en el menú Inicio.
4. La base de datos queda en `%APPDATA%\Cooperativa NFC\cooperativa.db` (no se borra al desinstalar).

### macOS (11 o superior)
1. Descargue el archivo para su Mac: `CooperativaNFC-1.0.0-arm64.dmg/.zip` (Apple Silicon M1/M2/M3/M4) o `-x64` (Intel).
2. Arrastre **Cooperativa NFC** a *Aplicaciones*.
3. Si la app no está firmada/notarizada, macOS dirá que *“no se puede abrir porque proviene de un desarrollador no identificado”* o que *“está dañada”*. Solución:
   - Clic derecho sobre la app → **Abrir** → **Abrir**; o en *Ajustes del Sistema → Privacidad y seguridad* → **Abrir igualmente**.
   - Si dice “dañada” (común en Apple Silicon con builds hechos fuera de una Mac), en Terminal:
     ```bash
     xattr -cr "/Applications/Cooperativa NFC.app"
     codesign --force --deep --sign - "/Applications/Cooperativa NFC.app"
     ```
4. La base queda en `~/Library/Application Support/Cooperativa NFC/cooperativa.db`.

### Primer uso
La primera vez la app pregunta cómo empezar:
- **Cargar datos de demostración** (usuarios, alumnos, tarjetas, productos y movimientos de ejemplo; ideal para capacitar).
- **Empezar con base vacía**: solo existe `admin` / `admin123` y se pide cambiar la contraseña al entrar.

Para volver a empezar, cierre la app y borre (o renombre) el archivo `cooperativa.db` indicado arriba.

### Credenciales de demostración

| Rol | Usuario | Contraseña |
|---|---|---|
| Administrador | `admin` | `admin123` |
| Cajero | `cajero` | `cajero123` |
| Tutora (Sofía y Diego) | `maria` (o `maria@example.com` / `4431234567`) | `tutor123` |
| Tutor (Valentina) | `juan` (o `juan@example.com`) | `tutor123` |

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
npm start            # abre la app de escritorio (crea la base demo en la carpeta userData)
npm test             # pruebas automáticas (lógica de negocio, API IPC, autenticación del servidor)
npm run e2e          # prueba de interfaz del escritorio (Electron, guarda capturas en e2e-shots/)
npm run server       # servidor + PWA en http://localhost:3000 (base en data/servidor.db, con demo)
npm run e2e:web      # prueba de interfaz de la PWA (registro, cambio obligatorio, recuperación)
npm run seed -- demo.db   # crea una base demo en un archivo
```
Variable útil: `COOP_DB_PATH=/ruta/otra.db npm start` usa otra base (pruebas o modo portátil).
En Linux sin sandbox de Chrome (contenedores) agregue `-- --no-sandbox`.

### Estructura
```
src/
  core/            Lógica de negocio sin dependencias de Electron (probada con node:test)
    db.js          Esquema SQLite, migraciones, transacciones y guardado atómico (sql.js)
    service.js     Reglas: usuarios, alumnos, tarjetas, productos, límites, compras, recargas, reportes
    auth.js        Autenticación del servidor: JWT, refresh tokens, invitaciones, recuperación, rate limit
    sync-client.js Sincronización lado escritorio (cola sync_outbox, pull/push, estado)
    sync-server.js Sincronización lado servidor (equipos, push idempotente, bitácora de ajustes, pull)
    api.js         Enrutador (lista blanca de métodos) usado por IPC y por el servidor
    seed.js        Datos de demostración
  main/            Proceso principal de Electron
    main.js        Ventana, IPC, sesiones, respaldo, configuración del servidor
    preload.js     Puente seguro (contextIsolation + sandbox)
    nfc.js         Lector PC/SC opcional (nfc-pcsc) → envía UID al punto de venta por IPC
    remote-auth.js Login de escritorio contra el servidor con respaldo sin conexión
  renderer/        Interfaz (index.html, styles.css, app.js) — la misma se usa en la PWA
server/
  app.js, index.js Servidor Express (API REST + PWA)
  public/          index.html, coop-web.js (adaptador REST), manifest, service worker, íconos
test/              Pruebas node:test
scripts/           seed-cli, e2e (escritorio) y e2e-web (PWA)
examples/          Script para probar un lector PC/SC
build/             Íconos para los instaladores
docs/capturas/     Capturas de pantalla
```

### Modelo de datos
`schools` (estado activa/prueba/suspendida, plan, contacto, equipo principal) y `school_id` en las tablas de cada escuela (ver 1b); `users` (rol superadmin/admin/cajero/tutor, `must_change_password`, `token_version`), `children` (tutor opcional hasta vincularse), `cards` (`uid` único, `child_id`, estado activa/bloqueada/perdida/sin_asignar, `balance_cents` entero ≥ 0), `categories`, `products` (`price_cents`), `transactions` (tipo compra/recarga/ajuste, estado aprobado/rechazado, motivo, monto, saldo después, tarjeta, alumno, usuario que procesó, fecha/hora local), `transaction_items`, `limits` (por compra, diario, periodo semana/mes; cada uno puede ser nulo), `prohibited_products`, `prohibited_categories`, y para el servidor `refresh_tokens`, `password_resets`, `invitations`.

---

## 4. Cuentas, inicio de sesión y seguridad

### Escritorio (local, sin internet)
- Usuarios en la base local, contraseñas con **bcrypt**. La sesión vive en el proceso principal (el renderer nunca decide el rol); cada operación valida el rol en `service.js`.
- Contraseña asignada por el admin ⇒ **cambio obligatorio** en el siguiente inicio (casilla configurable).
- **Con servidor configurado** (*Ajustes → Servidor en la nube*): el admin/cajero inicia sesión con su cuenta **del servidor**. Si el servidor acepta, la cuenta se copia/actualiza en la base local (hash bcrypt) para poder entrar **sin internet** después. Si el servidor rechaza la contraseña, se rechaza. Si el servidor no responde (5 s), se usa el login local (*modo sin conexión*). Las cuentas de tutor siguen funcionando localmente. Si la cuenta tiene contraseña temporal en el servidor, primero hay que cambiarla en la PWA.

### Servidor / PWA
- **Altas de tutores**: (1) el admin crea la cuenta con correo o teléfono y el servidor genera una **contraseña temporal** (se muestra una sola vez y se envía por el *mailer*); el tutor debe cambiarla al primer inicio. (2) El admin genera un **código de invitación por alumno** (`COOP-XXXX-XXXX`, vence en 30 días, un solo uso; generar otro invalida el anterior) que se entrega con la tarjeta; el padre se **autoregistra** en la PWA y queda vinculado. Un tutor ya registrado puede vincular más hijos con otro código. Si el alumno ya tenía tutor, el código transfiere la vinculación.
- Inicio de sesión con usuario, **correo o teléfono** (10 dígitos).
- **JWT de acceso** (HS256, 15 min) + **refresh token** opaco (30 días, guardado como hash SHA-256, **rotación** en cada uso y **detección de reutilización**: si se usa uno ya rotado, se revoca toda la familia).
- **Límite de intentos**: 5 fallos por cuenta en 15 min y 30 por IP ⇒ HTTP 429. Recuperación limitada a 5 por hora.
- **Cambio obligatorio de contraseña**: con `must_change_password` solo se permiten `/api/auth/me`, `/api/auth/change-password` y `/api/auth/logout*`; el resto responde 403 `DEBE_CAMBIAR_PASSWORD`.
- **Cerrar sesión** (revoca el refresh token) y **cerrar sesión en todos los dispositivos** (revoca todos e incrementa `token_version`, lo que invalida de inmediato los JWT emitidos). Cambiar o restablecer la contraseña, o desactivar al usuario, también invalida sesiones.
- **Recuperación de contraseña**: `/api/auth/forgot` responde igual exista o no la cuenta (no permite enumerar usuarios); genera un token aleatorio de un solo uso, válido 1 hora, y envía un enlace `APP_URL/?reset=<token>`.
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
| `SUPERADMIN_USER`, `SUPERADMIN_PASSWORD` | Crea la cuenta del **superadministrador** (Zuki Company) si no existe; contraseña ≥ 8 y **cambio obligatorio** al primer inicio. Por defecto el usuario es `zuki`. |
| `ADMIN_USER`, `ADMIN_PASSWORD`, `SCHOOL_NAME` | Opcional: crea una primera escuela con su administrador (cambio obligatorio). Normalmente las escuelas se crean desde el panel del superadmin. |
| `TRUST_PROXY=1` | Detrás de un proxy (Render, Railway, Nginx) para que el límite por IP use la IP real |

---

## 5. Sincronización escritorio ↔ servidor

### Configurar (una vez)
1. Despliegue el servidor **vacío** (`NODE_ENV=production`, sin datos demo) con `SUPERADMIN_USER`/`SUPERADMIN_PASSWORD`. El superadmin crea la escuela en **Instituciones → + Nueva escuela** y entrega al administrador de la escuela su usuario y contraseña temporal; este la cambia en la PWA.
2. En la caja: *Ajustes → Servidor en la nube y sincronización*: escriba la URL, el usuario y la contraseña **del administrador de la escuela** y pulse **Vincular este equipo** (la caja queda ligada a esa escuela y toma su nombre). La contraseña no se guarda: el servidor entrega un **token de equipo** (guardado en `config.json` de la carpeta de datos, revocable desde el servidor).
3. La primera sincronización envía **todo** lo existente (catálogo, alumnos, tarjetas con saldo, límites, prohibiciones e historial completo). Después se envían solo los cambios.
4. En la PWA el administrador genera los **códigos de invitación** de cada alumno (los alumnos ya llegaron desde la caja) y se los entrega a los padres.

### Qué viaja y quién gana
| Dato | Dirección | Regla |
|---|---|---|
| Movimientos (compras, recargas, ajustes, **incluidos los rechazados**) con sus partidas | caja → servidor | El escritorio es la fuente de verdad. Inmutables, **idempotentes por UUID** (reenviar no duplica). |
| Tarjetas (UID, alumno, estado, **saldo**) | caja → servidor | El saldo del servidor se reemplaza por el del escritorio, así que **refleja siempre a la caja**. |
| Alumnos (nombre, grado, foto, activo), productos, categorías | caja → servidor | Upsert por UUID. |
| Límites y prohibiciones (productos y categorías) | ambos sentidos | **Gana el servidor**: si el tutor cambió algo en el servidor después de la última descarga de la caja, se descarta lo enviado por la caja y la caja adopta el valor del servidor. |
| Bloqueo/desbloqueo de tarjeta por el tutor | servidor → caja | Gana el servidor; excepción: una tarjeta reportada **perdida** en la caja siempre queda perdida. |
| Perfil del alumno editado por el tutor (nombre/foto) | servidor → caja | Gana el servidor. |
| Vínculo tutor ↔ alumno y datos del tutor | servidor → caja | Gana el servidor. La caja crea una cuenta local del tutor sin contraseña utilizable (los padres usan la PWA; el admin puede asignarle una). |

Cada ciclo: **1) descarga** (pull) los ajustes cambiados desde el último cursor; **2) envía** (push) la cola local `sync_outbox` en lotes de 400. Los cambios se registran con *triggers* de SQLite en la caja; los cambios aplicados desde el servidor no se vuelven a encolar.

### Sin internet
La caja sigue vendiendo y recargando con su base local; los cambios se acumulan en la cola y se envían solos al volver la conexión. El indicador del menú lateral muestra el estado: *Sincronizado HH:MM*, *Sincronizando…*, *Sin conexión · N pendientes*, *Solo lectura*, *Otro equipo es el principal* o *Error*. Clic en el indicador = sincronizar ahora. *Ajustes* muestra la última sincronización, pendientes, equipo y resultado del último ciclo. Mientras la caja está sin conexión, los cambios que hagan los padres se aplican en la caja en cuanto se reconecta.

### Varios equipos (criterio conservador)
- Solo **un equipo principal por escuela** puede enviar datos (el primero que sincroniza). Otros equipos vinculados quedan en **solo lectura**: descargan los ajustes pero **sus ventas no se envían** (el servidor responde 409). Así se evita que dos cajas sobrescriban saldos de la misma tarjeta.
- Para cambiar de caja (p. ej. computadora nueva): en la nueva, *Vincular* y luego **Hacer principal** (requiere admin del servidor). Lo ideal es restaurar antes en la nueva el respaldo de la caja anterior.
- Con una caja vinculada, el servidor **rechaza** en la PWA las operaciones que pertenecen a la caja (ventas, recargas, ajustes, alta/asignación de tarjetas, alumnos, productos y categorías) con el código `SOLO_ESCRITORIO`.
- Varias cajas vendiendo simultáneamente con saldos compartidos **no está soportado** (ver `PENDIENTES.md`).

### Endpoints de sincronización
Autenticación: encabezado `X-Device-Token: <token>` (o `Authorization: Bearer <JWT de admin/cajero>` + `X-Device-Id` de un equipo vinculado).

| Método y ruta | Quién | Descripción |
|---|---|---|
| `POST /api/sync/devices` | admin (JWT) | `{device_id, name}` → `{device_token}` vincula un equipo |
| `GET /api/sync/devices` | admin | lista de equipos (principal, último contacto) |
| `POST /api/sync/devices/:id/primary` | admin | convierte un equipo en principal |
| `POST /api/sync/devices/:id/revoke` | admin | revoca un equipo |
| `GET /api/sync/status` | equipo | `{is_primary, primary_device, school_name, school_status}` |
| `POST /api/sync/invitations` | equipo | `{child_uuids, include_linked?}` → códigos de invitación de alumnos **de su escuela** (reutiliza los vigentes) |
| `GET /api/sync/pull?cursor=N` | equipo | `{cursor, changes:[{entity: limits|prohibitions|card_status|child_profile|child_link, ...}]}` |
| `POST /api/sync/push` | equipo principal | `{pulled_cursor, entities:{categories, products, children, cards, limits, prohibitions, transactions}}` → estadísticas (`duplicates`, `conflicts_server_wins`) |

---

## 6. API

### Escritorio (IPC)
El renderer llama `window.coop.call(metodo, args)`; el proceso principal agrega el usuario de la sesión y ejecuta `api.handle`. Respuesta: `{ ok: true, data }` o `{ ok: false, error, code }`.

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
npm run dist:win     # Windows x64 → dist/CooperativaNFC-Setup-1.0.0.exe (NSIS, en español)
npm run dist:mac     # macOS → dist/*.dmg y *.zip para x64 y arm64 (requiere una Mac)
npm run dist:linux   # Linux → dist/CooperativaNFC-1.0.0-x86_64.AppImage (pruebas)
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

## 8. Desplegar el servidor (opcional)

El servidor necesita un proceso Node **siempre encendido** y **disco persistente** para el archivo SQLite. **Netlify / Vercel (solo estático o funciones sin estado) no sirven por sí solos** para el backend; pueden alojar únicamente archivos estáticos.

- **VPS** (DigitalOcean, Linode, Hetzner, AWS Lightsail; ~5 USD/mes): Node 20, `npm ci --omit=dev`, servicio `systemd` o `pm2` con las variables de la sección 4, Nginx/Caddy como proxy con HTTPS (Let's Encrypt), `TRUST_PROXY=1`.
- **Render**: *Web Service* con `npm ci --omit=dev` / `node server/index.js`, **Persistent Disk** montado en `/data` y `DB_PATH=/data/servidor.db`.
- **Railway / Fly.io**: usar el `Dockerfile` incluido y un **volumen** en `/data`.
- HTTPS es obligatorio en producción (PWA, Web NFC y seguridad de tokens).
- Respaldos: copie `servidor.db` a diario (cron + almacenamiento externo). Use una sola instancia (SQLite + límites en memoria); para escalar, migrar a PostgreSQL y Redis.

---

## 9. Pruebas realizadas

- `npm test`: **36 pruebas, 36 aprobadas** — **multi-escuela** (`test/tenant.test.js`): el admin de la escuela A no ve ni modifica datos de la B en ningún endpoint (alumnos, tarjetas, productos, categorías, movimientos, usuarios, tablero, invitaciones, equipos, compras/recargas con tarjeta o producto ajeno ⇒ 404), UID repetido entre escuelas rechazado, tutor con hijos en dos escuelas ve solo los suyos, superadmin ve todo y totales correctos (los demás reciben 403), alta de escuela con admin temporal, suspensión (personal bloqueado, padres sí), sincronización aislada por escuela con conflicto de UID, códigos desde la caja solo de su escuela, y migración de una base real de la versión anterior; además: saldo insuficiente, límite por compra, diario (y reinicio al día siguiente), semanal/mensual, producto prohibido, categoría prohibida, tutor sin acceso a hijo ajeno (en servicio, IPC y REST), recarga actualiza saldo, tarjeta bloqueada, tarjeta perdida con transferencia de saldo, validaciones, persistencia en archivo; autenticación: login por usuario/correo/teléfono, límite de intentos (429), rotación y reutilización de refresh tokens, logout, expiración de sesión, contraseña temporal con cambio obligatorio, invitaciones (registro, un solo uso, vincular otro hijo), recuperación de contraseña, roles en cada endpoint, login del escritorio contra el servidor con respaldo sin conexión; **sincronización**: envío inicial completo con saldos idénticos e idempotencia (reenvío sin duplicados), límites/prohibiciones/bloqueo hechos por el tutor en el servidor que afectan la siguiente venta de la caja (y rechazos visibles para el tutor), el servidor gana en conflictos, cola sin conexión que se envía al reconectar, equipo secundario en solo lectura, bloqueo de ventas en línea y autenticación de los endpoints.
- `npm run e2e` y `npm run e2e:web`: *Programar tarjetas* completo (lectura en lote con duplicado, asignación en orden, hoja con códigos del servidor y PDF generado), panel del superadmin en escritorio, tableta y celular (alta de escuela, detalle, hoja de códigos) y tutora con hijos en dos escuelas; además recorren todas las pantallas por rol, vinculan la caja con un servidor real y verifican que el saldo del servidor refleje una venta, hacen ventas aprobadas/rechazadas, simulan un lector USB tipo teclado, registro con invitación, cambio obligatorio, recuperación y sesión persistente.

Más: integración con lectores en `INTEGRACION_NFC.md`; mejoras futuras en `PENDIENTES.md`.
