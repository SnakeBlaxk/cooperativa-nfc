# Guía de arranque — Cooperativa NFC para escuelas

Guía sencilla, paso a paso, para poner a funcionar la cooperativa con tarjetas en una escuela.
Está pensada para alguien **sin conocimientos técnicos**. Si algún paso le resulta difícil, pida ayuda una sola vez a un técnico para el **Paso 1** (el servidor); lo demás se hace con clics.

**Palabras que usaremos**

| Palabra | Qué es |
|---|---|
| **Servidor** | La "página de internet" del sistema. Ahí entran los padres desde su celular y ahí Zuki Company administra todas las escuelas. Se instala **una sola vez** para todas las escuelas. |
| **Superadministrador** | La cuenta de Zuki Company (dueña del sistema). Da de alta escuelas. |
| **Administrador de la escuela** | La persona de la escuela que maneja la cooperativa (precios, alumnos, tarjetas). |
| **Caja** | La computadora de la cooperativa donde se cobra, con el programa "Cooperativa NFC" instalado. |
| **Lector** | El aparatito USB donde se acerca la tarjeta. |
| **Código de invitación** | Un código como `COOP-AB12-CD34` que se entrega al papá o mamá para que cree su cuenta y vea a su hijo. |

---

## Paso 1. Poner el servidor en internet (una sola vez, para todas las escuelas)

> Esto lo hace Zuki Company **una vez**. Después solo se agregan escuelas desde una pantalla.

Necesita (costo aproximado 7 a 10 USD al mes): una cuenta en un servicio de hospedaje que mantenga el programa encendido y guarde los datos en un **disco permanente**. Recomendamos **Render** (render.com) o **Railway** (railway.app). *Netlify o Vercel no sirven para esto.*

1. Suba la carpeta del programa (el archivo `cooperativa-nfc.zip` descomprimido) a una cuenta de **GitHub** (github.com → *New repository* → *uploading an existing file*).
2. En **Render**: *New* → *Web Service* → elija ese repositorio. Render detecta el archivo `Dockerfile` solo.
3. Agregue un **disco** (*Disks* → *Add disk*): ruta de montaje `/data`, 1 GB es suficiente.
4. En *Environment* (variables) escriba estas líneas:

   | Nombre | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | una frase larga y secreta de al menos 32 letras y números (ejemplo: `zuki-morelia-2026-clave-muy-larga-x7Q9pL2`) — **no la comparta** |
   | `SUPERADMIN_USER` | `zuki` (o el usuario que prefiera) |
   | `SUPERADMIN_PASSWORD` | una contraseña temporal de al menos 8 caracteres |
   | `APP_URL` | la dirección que le dio Render, por ejemplo `https://cooperativa-zuki.onrender.com` |
   | `TRUST_PROXY` | `1` |

5. Pulse **Deploy** (Desplegar). En unos minutos estará lista la dirección, por ejemplo `https://cooperativa-zuki.onrender.com`.
6. Abra esa dirección en el navegador, entre con `zuki` y la contraseña temporal. **El sistema le pedirá cambiarla**: elija una contraseña larga y guárdela en un lugar seguro.

✅ Listo: ya ve la pantalla **Instituciones** (vacía).

> Consejo: anote la dirección del servidor; la usará en la caja y la recibirán los padres.
> Respaldo: pida al técnico que programe una copia diaria del archivo `/data/servidor.db`.

---

## Paso 2. Dar de alta una escuela nueva

En el servidor, con la cuenta del **superadministrador**:

1. **Instituciones** → botón **+ Nueva escuela**.
2. Escriba el **nombre** de la escuela, el **estado** (*En prueba* si es demostración, *Activa* si ya contrató), el contacto y una nota del plan o cuota (ejemplo: "Plan anual $1,500 MXN/mes, paga el día 5").
3. En "Administrador de la escuela" escriba un **usuario** (ejemplo: `admin.juarez`) y el nombre de la persona.
4. Pulse **Crear escuela**. Aparece una **contraseña temporal**: **anótela** (solo se muestra una vez) y entréguela a esa persona junto con el usuario y la dirección del servidor.
5. El administrador de la escuela entra a la dirección del servidor con ese usuario; el sistema le pedirá cambiar la contraseña.

En **Instituciones → Administrar** puede después: editar datos y plan, **suspender** (si no paga) o **activar**, crear más usuarios (cajeros), restablecer contraseñas, ver ventas, recargas, alumnos y la **última sincronización** de la caja, y revocar cajas.

---

## Paso 3. Instalar el programa en la caja (computadora de la cooperativa)

1. Copie a la computadora el instalador:
   - Windows: `CooperativaNFC-Setup-1.0.0.exe`
   - Mac: el archivo `.zip` (Apple M1/M2/M3 = `arm64`, Mac con Intel = `x64`)
2. **Windows**: ábralo. Si sale "Windows protegió su PC", pulse **Más información → Ejecutar de todas formas**. Siga los pasos hasta terminar.
   **Mac**: abra el zip, arrastre la app a *Aplicaciones*, y la primera vez ábrala con **clic derecho → Abrir → Abrir**.
3. Conecte el **lector** de tarjetas al USB.
4. Abra **Cooperativa NFC**. La primera vez pregunta cómo empezar: elija **Empezar con base vacía**.
5. Entre con `admin` / `admin123`; le pedirá crear una contraseña nueva. (Esta cuenta es solo de esta computadora; en el Paso 4 se usará la cuenta de la escuela.)

---

## Paso 4. Vincular la caja con la escuela

En la caja, con el usuario administrador:

1. Menú **Ajustes** → recuadro **Servidor en la nube y sincronización**.
2. Escriba la **dirección del servidor** (la del Paso 1), y el **usuario y contraseña del administrador de la escuela** (los del Paso 2, ya cambiada).
3. Pulse **Probar conexión** (debe decir "Conexión correcta") y luego **Vincular este equipo**.
4. Abajo a la izquierda debe aparecer un punto verde: **Sincronizado**. En Ajustes verá "Escuela: *nombre de su escuela*".

5. **Importante:** desde ahora, en la caja se entra con las cuentas **de la escuela en el servidor** (por ejemplo `admin.juarez`), ya no con el `admin` local del Paso 3. Cierre sesión y entre con su cuenta de la escuela.

A partir de ahora la caja envía sola las ventas y recargas al servidor (cada 45 segundos y después de cada venta). **Si se va el internet, la caja sigue cobrando** y envía todo cuando regresa.

> Cada caja pertenece a **una sola escuela**. Para usarla en otra escuela, hay que reinstalar con base vacía.

---

## Paso 5. Preparar productos y alumnos

En la caja (administrador):

1. **Productos**: revise las categorías (Dulces, Refrescos, Frituras, Saludable, Comida) y agregue cada producto con su **precio en pesos**.
2. **Tutores y alumnos** → **+ Alumno**: escriba nombre completo y grado/grupo (ejemplo `3° A`). No necesita escribir al papá: él se vinculará con su código.
3. **Cuenta del cajero**: como la caja está vinculada, las cuentas del personal se crean **en el servidor**: el administrador de la escuela entra a la dirección del servidor (en el navegador) → **Usuarios** → **+ Usuario** → rol *Cajero*. (O se la pide al superadministrador: *Administrar → + Usuario*.) El cajero entra **primero una vez en el navegador** para cambiar su contraseña temporal; después ya puede entrar en la caja con ese usuario; la caja lo recuerda para poder entrar aunque no haya internet.

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

**6.3 Hoja de códigos para los papás**
1. Pulse **3. Hoja de códigos para padres**.
2. Deje marcados los alumnos (por defecto, los que aún no tienen papá vinculado). Puede elegir un grado.
3. Pulse **Generar hoja (PDF / imprimir)**. La caja se sincroniza y trae un código para cada alumno.
4. Pulse **Guardar PDF…** o **Imprimir**. Cada recuadro trae: nombre, grado, número de tarjeta, **código** y los pasos para el papá.
5. Recorte los recuadros y entréguelos **junto con la tarjeta** (en un sobre por alumno).

> Si la caja no está vinculada (Paso 4), la hoja sale sin códigos.
> Los códigos vencen en 30 días; si se vence, vuelva a generar la hoja (se crea uno nuevo).

---

## Paso 7. Inscribir a los papás

Lo hace cada papá o mamá desde su celular, con el recuadro que recibió:

1. Abrir la **dirección del servidor** en el navegador del celular (Chrome o Safari).
2. Tocar **"Tengo un código de invitación"**.
3. Escribir el **código**, su nombre, su correo o teléfono y una contraseña (mínimo 8 caracteres).
4. ¡Listo! Ya ve el **saldo** y el **historial** de su hijo, y puede poner **límites** (por compra, por día, por semana o mes), **prohibir** productos o categorías y **bloquear** la tarjeta si se pierde.
5. Recomendación: en el navegador usar "Agregar a pantalla de inicio" para tenerlo como app.
6. Si tiene otro hijo (aunque esté en **otra escuela** que use el sistema), en **Mis hijos** → **+ Vincular hijo con código** escribe el otro código.

---

## Paso 8. Primera recarga

En la caja (cajero o administrador):

1. Menú **Recargas**.
2. Acerque la tarjeta del alumno (aparece su nombre y saldo).
3. Toque un monto rápido ($50, $100, $200…) o escríbalo, y pulse **Registrar recarga**.
4. Reciba el dinero en efectivo. El papá verá la recarga en su celular en menos de un minuto.

---

## Paso 9. Operación diaria

**Al abrir**
- Encienda la computadora, abra **Cooperativa NFC** y entre con el usuario del **cajero**.
- Revise que el punto abajo a la izquierda esté **verde (Sincronizado)**. Si está amarillo ("Sin conexión") puede trabajar igual.

**Para cobrar** (menú **Punto de venta**)
1. El alumno acerca su tarjeta.
2. Toque los productos que lleva (los prohibidos por su papá aparecen en **rojo**).
3. Pulse **Cobrar** (o la tecla F2).
4. Si sale **"Venta aprobada"** entregue los productos. Si sale **en rojo**, el mensaje dice por qué (sin saldo, límite del día, producto prohibido, tarjeta bloqueada) y **no se cobra**.

**Al cerrar**
- El administrador revisa el **Panel** (ventas y recargas del día) y **Movimientos** (puede exportar a Excel con "Exportar CSV").
- En **Ajustes** pulse **Crear respaldo…** y guarde el archivo en una USB (una vez al día).
- Antes de apagar, pulse el indicador de sincronización para enviar lo último.

---

## Paso 10. ¿Qué hacer si se pierde una tarjeta?

1. **El papá** puede bloquearla al momento desde su celular (*Mis hijos → el alumno → Tarjeta y perfil → Bloquear temporalmente*). Así nadie puede gastar el saldo.
2. **En la caja** (administrador): menú **Tarjetas** → busque la tarjeta del alumno → botón **Perdida**.
3. Si ya tiene una tarjeta nueva, haga clic en el campo "Tarjeta nueva", acérquela al lector (o escriba su número) y pulse **Reportar perdida**: **todo el saldo pasa a la tarjeta nueva**.
4. Si todavía no tiene tarjeta nueva, confirme sin escribir nada: el saldo **queda guardado** y se abona solo cuando le asigne una tarjeta (en *Tarjetas* o *Programar tarjetas*).
5. La tarjeta perdida queda inutilizable para siempre (aunque aparezca después).
6. El papá no necesita un código nuevo: sigue viendo a su hijo con la tarjeta nueva.

---

## Problemas frecuentes

| Problema | Qué hacer |
|---|---|
| El lector no lee | Desconecte y vuelva a conectar el USB. Haga clic en el campo de la tarjeta y acérquela de nuevo. |
| Indicador rojo "Error de sincronización" | Pulse el indicador para reintentar. Si dice "suspendido", comuníquese con Zuki Company. |
| "Otro equipo es el principal" | Hay otra caja de la escuela enviando datos. En Ajustes, con la cuenta del administrador de la escuela, pulse **Hacer principal** en la caja correcta. |
| "Esa tarjeta ya está registrada en otra escuela" | Esa tarjeta pertenece a otra escuela; use otra tarjeta. |
| Un papá olvidó su contraseña | En la página de inicio del servidor: **¿Olvidaste tu contraseña?** |
| El administrador olvidó su contraseña | El superadministrador: *Instituciones → Administrar → Restablecer contraseña*. |
| La escuela dejó de pagar | El superadministrador: *Administrar → Suspender*. El personal ya no podrá entrar; los papás aún ven el saldo. Para reactivar: **Activar**. |

¿Dudas? Zuki Company — soporte de Cooperativa NFC.
