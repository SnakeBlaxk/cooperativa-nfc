# Guía de arranque — Zuki Pay para escuelas

Guía sencilla, paso a paso, para poner a funcionar la cooperativa con tarjetas en una escuela.
> ## ⚠️ Se necesita internet
> El sistema **solo funciona con internet**. Todo se guarda al momento en el servidor, por eso la computadora de la cooperativa, la tableta y el celular de los papás siempre ven lo mismo.
> Si se va el internet, en la pantalla aparece **“Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.”** y **no se puede cobrar ni recargar**. No hay que hacer nada: en cuanto regresa el internet el aviso se quita solo y se puede seguir.
> Recomendación: tenga a la mano un plan B de internet (por ejemplo, compartir datos desde un celular).

Está pensada para alguien **sin conocimientos técnicos**. Si algún paso le resulta difícil, pida ayuda una sola vez a un técnico para el **Paso 1** (el servidor); lo demás se hace con clics.

**Palabras que usaremos**

| Palabra | Qué es |
|---|---|
| **Servidor** | La "página de internet" del sistema. Ahí entran los padres desde su celular y ahí Zuki Company administra todas las escuelas. Se instala **una sola vez** para todas las escuelas. |
| **Superadministrador** | La cuenta de Zuki Company (dueña del sistema). Da de alta escuelas. |
| **Administrador de la escuela** | La persona de la escuela que maneja la cooperativa (precios, alumnos, tarjetas). |
| **Caja** | La computadora (o tableta) de la cooperativa donde se cobra. Puede ser el programa "Zuki Pay" instalado o simplemente el navegador con la dirección del servidor: es la misma app. **Necesita internet.** |
| **Lector** | El aparatito USB donde se acerca la tarjeta. |
| **Código de invitación** | Un código como `COOP-AB12-CD34` que se entrega al papá o mamá para que cree su cuenta y vea a su hijo. |

---

## Paso 1. Poner el servidor en internet (una sola vez, para todas las escuelas)

> Esto lo hace Zuki Company **una vez**. Después solo se agregan escuelas desde una pantalla.

Necesita una cuenta en un servicio de hospedaje que mantenga el programa encendido y **guarde los datos de forma permanente**. Recomendamos **Render** (render.com). *Netlify o Vercel no sirven para esto.* Vea abajo **“Guardar los datos”**: sin ese paso, el servidor gratuito borra todo cada vez que se reinicia.

1. Suba la carpeta del programa (el archivo `cooperativa-nfc.zip` descomprimido) a una cuenta de **GitHub** (github.com → *New repository* → *uploading an existing file*).
2. En **Render**: *New* → *Web Service* → elija ese repositorio. Render detecta el archivo `Dockerfile` solo.
3. Elija cómo guardar los datos (sección **Guardar los datos**, más abajo).
4. En *Environment* (variables) escriba estas líneas:

   | Nombre | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | una frase larga y secreta de al menos 32 letras y números (ejemplo: `zuki-morelia-2026-clave-muy-larga-x7Q9pL2`) — **no la comparta** |
   | `SUPERADMIN_USER` | `zuki` (o el usuario que prefiera) |
   | `SUPERADMIN_PASSWORD` | su contraseña de superadministrador (al menos 10 caracteres) |
   | `APP_URL` | la dirección que le dio Render, por ejemplo `https://cooperativa-zuki.onrender.com` |
   | `TRUST_PROXY` | `1` |

5. Pulse **Deploy** (Desplegar). En unos minutos estará lista la dirección, por ejemplo `https://cooperativa-zuki.onrender.com`.
6. Abra esa dirección en el navegador y entre con `zuki` y esa contraseña. Puede cambiarla en **Mi cuenta**. Guárdela en un lugar seguro.

✅ Listo: ya ve la pantalla **Escuelas** (vacía).

> Consejo: anote la dirección del servidor; la usará en la caja y la recibirán los padres.
> Respaldo: en **Seguridad y emergencia → Descargar respaldo** baje una copia cada semana y guárdela en una USB o en su nube.

### Guardar los datos (muy importante)

| Opción | Costo | Para qué |
|---|---|---|
| **Turso** (turso.tech) | Gratis | Prueba piloto. Se crea una cuenta, una base y se copian 2 datos a Render. |
| **Render Starter + disco 1 GB** | ≈ 7.25 USD al mes | Escuela real: el servidor no se “duerme” y los datos quedan en disco con copia diaria. |

Pasos exactos en el `README.md`, sección 8. Para saber cuál está activa: **Seguridad y emergencia → Dónde se guardan los datos** (si dice **TEMPORAL**, los datos se borrarán).

### Si olvida la contraseña del superadministrador
En Render → *Environment* agregue `SUPERADMIN_RESET_PASSWORD` con una contraseña nueva, guarde, entre con ella y **después borre esa variable**.

---

## Paso 2. Dar de alta una escuela nueva

En el servidor, con la cuenta del **superadministrador**:

1. **Escuelas** → botón **+ Nueva escuela**.
2. Escriba el **nombre** de la escuela, el **estado** (*En prueba* si es demostración, *Activa* si ya contrató), el contacto y una nota del plan o cuota (ejemplo: "Plan anual $1,500 MXN/mes, paga el día 5").
3. En "Administrador de la escuela" escriba un **usuario** (ejemplo: `admin.juarez`) y el nombre de la persona.
4. Pulse **Crear escuela**. Aparece la **contraseña** del administrador con un botón **Copiar**: se muestra una sola vez; entréguela a esa persona junto con el usuario y la dirección del servidor.
5. El administrador de la escuela entra a la dirección del servidor con ese usuario y contraseña. **Solo usted (superadministrador) puede cambiar contraseñas**: si alguien la olvida, vaya a **Cuentas → 🔑 Contraseña**.

Para corregir los datos de cualquier cuenta (nombre, usuario, correo, teléfono, puesto, escuela o los hijos de un papá): **Cuentas → ✏️ Editar**. Cada cambio queda en la **Bitácora**. En tableta (iPad) la lista se ve como tarjetas.

En **Escuelas → Administrar** puede después: editar datos y plan, llevar la **mensualidad** (registrar pago / renovar, pausar ahora, reactivar, ver historial de pagos; si no paga, la escuela se pausa sola 2 días después de vencer), crear más usuarios (cajeros), asignar contraseñas nuevas, ver ventas, recargas, alumnos y la **última sincronización** de la caja, y revocar cajas.

---

## Paso 3. Instalar el programa en la caja (computadora de la cooperativa)

> En una **tableta** no hay que instalar nada: abra la dirección del servidor en el navegador (Chrome o Safari) y use "Agregar a pantalla de inicio".

1. Copie a la computadora el instalador:
   - Windows: `ZukiPay-Setup-2.1.0.exe`
   - Mac: el archivo `.zip` (Apple M1/M2/M3 = `arm64`, Mac con Intel = `x64`)
2. **Windows**: ábralo. Si sale "Windows protegió su PC", pulse **Más información → Ejecutar de todas formas**. Siga los pasos hasta terminar.
   **Mac**: abra el zip, arrastre la app a *Aplicaciones*, y la primera vez ábrala con **clic derecho → Abrir → Abrir**.
3. Conecte el **lector** de tarjetas al USB.
4. Abra **Zuki Pay** (con internet). Se conecta sola al servidor `https://cooperativa-nfc.onrender.com` y muestra la pantalla de entrada.
   - Si su servidor tiene otra dirección: menú **Archivo → Servidor…**, escríbala y pulse **Guardar y conectar**.
   - Si dice *Conectando con el servidor…* espere: el servidor gratuito puede tardar hasta 1 minuto en despertar.
5. Entre con el usuario y contraseña **del administrador de la escuela** (los del Paso 2). Ya no hay cuentas "locales" ni que vincular nada.

---

## Paso 4. (Ya no es necesario) Vincular la caja

Desde la versión 2.0 la caja **no se vincula ni se sincroniza**: es la misma app del servidor. Cada venta y recarga se guarda en el servidor en el mismo momento.

> **¿Tenía la caja anterior (versión 1)?** Antes de cambiarla, ábrala con internet y pulse **Sincronizar ahora** hasta que diga *Sincronizado* y *0 pendientes*. Después desinstálela e instale la versión 2.0. (Detalles técnicos en el `README.md`, sección 5.)

---

## Paso 5. Preparar productos y alumnos

En la caja o en el navegador (administrador):

1. **Productos**: revise las categorías (Dulces, Refrescos, Frituras, Saludable, Comida) y agregue cada producto con su **precio en pesos**.
2. **Tutores y alumnos** → **+ Alumno**: escriba nombre completo y grado/grupo (ejemplo `3° A`). No necesita escribir al papá: él se vinculará con su código.
3. **Cuenta del cajero**: las cuentas del personal se crean **en el servidor**: el administrador de la escuela entra a la dirección del servidor (en el navegador) → **Personal** → **+ Nueva cuenta** → puesto *Cajero*. (O se la pide al superadministrador: *Administrar → + Usuario*.) El cajero ya puede entrar en la caja con ese usuario y contraseña; la caja lo recuerda para poder entrar aunque no haya internet.

---

## Paso 6. Programar las tarjetas (muchas a la vez)

En la caja: menú **Programar tarjetas**.

**6.1 Leer tarjetas**
1. Ponga las tarjetas nuevas en una pila.
2. Acerque **una por una** al lector. Cada tarjeta nueva se marca en verde ("registrada") y el contador sube.
3. Si una sale en **rojo** ("ya está registrada"), sepárela: ya estaba dada de alta (en esta u otra escuela).

**6.2 Asignar a alumnos**
1. Pulse **2. Asignar a alumnos**. Verá la lista de alumnos **sin tarjeta**, ordenada por grado y nombre, y a cada uno el sistema le propone una tarjeta en el orden en que las leyó.
2. Opción fácil: acomode las tarjetas físicas en el mismo orden de la lista y pulse **Asignar seleccionadas** → **Confirmar**.
3. Opción una por una: pulse **Leer** junto al alumno y acerque su tarjeta.
4. Puede filtrar por grado para hacerlo salón por salón.

> Consejo: escriba el nombre del alumno en la tarjeta con plumón o pegue una etiqueta.

**Una sola tarjeta a la vez (también en tableta)**: en **Alumnos y padres**, junto al alumno sin tarjeta pulse **🪪 Asignar tarjeta**. El cursor ya queda en el campo: pase la tarjeta por el lector USB (de 125 kHz o NFC) o escriba el número y presione **Enter**. Ahí mismo puede **Bloquear**, **Reemplazar** (si se perdió o dañó; el saldo pasa a la nueva) o **Quitar** la tarjeta. El sistema no deja usar una tarjeta repetida.
También en **Tarjetas**: elija el alumno (o déjelo vacío para guardarla en inventario) y pase la tarjeta.

**6.3 Hoja de códigos para los papás**
1. Pulse **3. Hoja de códigos para padres**.
2. Deje marcados los alumnos (por defecto, los que aún no tienen papá vinculado). Puede elegir un grado.
3. Pulse **Generar hoja (PDF / imprimir)**. El servidor da un código para cada alumno.
4. Pulse **Guardar PDF…** o **Imprimir**. Cada recuadro trae: nombre, grado, número de tarjeta, **código** y los pasos para el papá.
5. Recorte los recuadros y entréguelos **junto con la tarjeta** (en un sobre por alumno).

> Los códigos vencen en 30 días; si se vence, vuelva a generar la hoja (se crea uno nuevo).

---

## Paso 7. Inscribir a los papás

Lo hace cada papá o mamá desde su celular, con el recuadro que recibió:

1. Abrir la **dirección del servidor** en el navegador del celular (Chrome o Safari).
2. Tocar **"Tengo un código de invitación"**.
3. Escribir el **código**, su nombre, su correo o teléfono y una contraseña (mínimo 8 caracteres).
4. ¡Listo! Ya ve el **saldo** y el **historial** de su hijo, y puede poner **límites** (por compra, por día, por semana o mes), **prohibir** productos o categorías y **bloquear** la tarjeta si se pierde.
   > Los **límites y productos prohibidos los pone solo el papá o la mamá**. La escuela puede verlos, pero no cambiarlos.
5. Recomendación: en el navegador usar "Agregar a pantalla de inicio" para tenerlo como app.
6. Si tiene otro hijo (aunque esté en **otra escuela** que use el sistema), en **Mis hijos** → **+ Vincular hijo con código** escribe el otro código.

---

## Paso 8. Primera recarga

En la caja (cajero o administrador):

1. Menú **Recargas**.
2. Acerque la tarjeta del alumno (aparece su nombre y saldo).
3. Toque un monto rápido ($50, $100, $200…) o escríbalo, y pulse **Registrar recarga**.
4. Reciba el dinero en efectivo. El papá ve la recarga en su celular **al instante**.

---

## Paso 9. Operación diaria

**Al abrir**
- Encienda la computadora, abra **Zuki Pay** y entre con el usuario del **cajero**.
- Verifique que haya internet. Si aparece el aviso **“Sin conexión a internet…”**, no se puede cobrar: revise el módem o comparta datos desde un celular; el aviso se quita solo cuando regresa la conexión.

**Para cobrar** (menú **Punto de venta**)
1. El alumno acerca su tarjeta.
2. Toque los productos que lleva (los prohibidos por su papá aparecen en **rojo**).
3. Pulse **Cobrar** (o la tecla F2).
4. Si sale **"Venta aprobada"** entregue los productos. Si sale **en rojo**, el mensaje dice por qué (sin saldo, límite del día, producto prohibido, tarjeta bloqueada) y **no se cobra**.
5. Si justo al cobrar se fue el internet y sale *“La operación NO se pudo confirmar”*: cuando regrese la conexión revise **Movimientos** para ver si la venta quedó antes de volver a cobrar.

**Al cerrar**
- El administrador revisa el **Panel** (ventas y recargas del día) y **Movimientos** (puede exportar a Excel con "Exportar CSV").
- Todo ya está guardado en el servidor; no hay que sincronizar ni respaldar la caja. (El superadministrador baja el respaldo del servidor.)

---

## Paso 10. ¿Qué hacer si se pierde una tarjeta?

1. **El papá** puede bloquearla al momento desde su celular (*Mis hijos → el alumno → Tarjeta y perfil → Bloquear temporalmente*). Así nadie puede gastar el saldo.
2. **En la caja** (administrador): **Alumnos y padres → Tarjeta** del alumno → **🔁 Reemplazar tarjeta** (pase la tarjeta nueva y pulse Enter). O bien menú **Tarjetas** → busque la tarjeta → botón **Perdida**.
3. Si ya tiene una tarjeta nueva, haga clic en el campo "Tarjeta nueva", acérquela al lector (o escriba su número) y pulse **Reportar perdida**: **todo el saldo pasa a la tarjeta nueva**.
4. Si todavía no tiene tarjeta nueva, confirme sin escribir nada: el saldo **queda guardado** y se abona solo cuando le asigne una tarjeta (en *Tarjetas* o *Programar tarjetas*).
5. La tarjeta perdida queda inutilizable para siempre (aunque aparezca después).
6. El papá no necesita un código nuevo: sigue viendo a su hijo con la tarjeta nueva.

---

## Problemas frecuentes

| Problema | Qué hacer |
|---|---|
| El lector no lee | Desconecte y vuelva a conectar el USB. Haga clic en el campo de la tarjeta y acérquela de nuevo. |
| Aviso "Sin conexión a internet. No se puede cobrar hasta que regrese la conexión." | No hay internet o el servidor no responde. Revise el módem o comparta datos desde un celular. El sistema reintenta solo; también puede pulsar **Reintentar ahora**. |
| "Servicio pausado" | La mensualidad no está al corriente: comuníquese con Zuki Company. Mientras esté pausada no se cobra ni se recarga. |
| La caja vieja dice "Esta versión de la caja ya no se usa" | Instale la versión 2.0 (Paso 3). |
| "Solo el padre, madre o tutor puede configurar…" | Los límites y prohibidos solo los cambia el papá desde su celular. |
| "Esa tarjeta ya está registrada en otra escuela" | Esa tarjeta pertenece a otra escuela; use otra tarjeta. |
| Un papá olvidó su contraseña | Le pide una nueva a la escuela; el superadministrador la asigna en **Cuentas → 🔑 Contraseña**. |
| El administrador olvidó su contraseña | El superadministrador: **Cuentas → 🔑 Contraseña**. |
| Sospecha de robo de contraseña o recargas falsas | Superadministrador: **Seguridad y emergencia** → congelar recargas de esa escuela, bloquear administradores, o el botón rojo **ALERTA ROJA** (todo queda en solo lectura). Revise **Alertas** y **Bitácora**. |
| La escuela dejó de pagar | El superadministrador: *Administrar → Suspender*. El personal ya no podrá entrar; los papás aún ven el saldo. Para reactivar: **Activar**. |

¿Dudas? Zuki Company — soporte de Zuki Pay.
