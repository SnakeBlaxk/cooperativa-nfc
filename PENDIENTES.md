# Pendientes y mejoras futuras

Lista priorizada de lo que falta o conviene pulir después de la versión 1.0.

## Alta prioridad
0. **Guardar los datos de forma permanente en el servidor**: hoy Render gratis usa `/tmp` (se borra al reiniciar). Configurar Turso (gratis) o Render Starter + disco (≈ 7.25 USD/mes). Pasos en README §8.
0b. Seguridad v2 — siguientes pasos: papelera también para alumnos/tarjetas/usuarios (hoy solo productos usan borrado suave; alumnos y usuarios se desactivan), verificación en dos pasos (2FA) para el superadmin, aviso por correo/WhatsApp de alertas críticas, y que la caja de escritorio aplique la reversión de una recarga automáticamente (hoy bloquea la tarjeta y la escuela hace el ajuste).
1. **Sincronización — mejoras**: la sincronización básica ya funciona (ver README §5). Falta: varias cajas vendiendo a la vez con saldos compartidos (requiere saldo calculado en el servidor a partir de movimientos y reservas en línea), pantalla en la PWA para ver/revocar equipos y cambiar el principal, envío de fotos por separado (hoy viajan dentro del lote), compresión de lotes grandes, alerta si la caja lleva mucho tiempo sin sincronizar, y edición de productos desde la PWA (hoy el catálogo se administra en la caja).
2. **Envío real de correos/SMS**: implementar el *mailer* con Resend / SendGrid / Amazon SES y Twilio (SMS o WhatsApp) para enviar contraseñas y avisos (la recuperación por correo está desactivada por política).
3. **Firma de código**: certificado de Windows (OV/EV) para evitar SmartScreen, y Apple Developer ID + notarización para macOS.
4. **Respaldos automáticos**: copia diaria programada en el escritorio (carpeta elegida o nube) y restauración desde la interfaz; en el servidor, cron + almacenamiento externo (S3/Backblaze) y prueba periódica de restauración.
5. **Aviso de privacidad y consentimiento** (LFPDPPP) integrados en el registro de la PWA, y opción de baja/anonimización de alumnos.

## Funciones
6. **Recargas en línea** desde la PWA: Mercado Pago, Openpay, Stripe, Conekta o Clip (tarjeta, OXXO, SPEI con CoDi/DiMo); webhook que acredita el saldo.
7. **Notificaciones a padres**: compra rechazada, saldo bajo, recarga recibida, resumen semanal (push de la PWA, correo o WhatsApp).
8. **App móvil** nativa o empaquetar la PWA (Capacitor) para tiendas, con notificaciones push.
9. **Corte de caja**: apertura/cierre de turno por cajero, efectivo esperado vs contado, reporte imprimible.
10. **Inventario**: existencias, alertas de stock bajo, entradas de mercancía, costo y utilidad.
11. **Ticket** impreso (impresora térmica) o mostrado en pantalla para el alumno.
12. **Reportes**: por grado/grupo, por categoría, consumo saludable vs no saludable, exportar a Excel/PDF.
13. **Múltiples tutores por alumno** (mamá y papá con cuentas separadas).
14. **Devoluciones** de una venta (hoy se hace con ajuste manual).
15. Límite por **horario** (p. ej. solo recreo) y lista de productos **permitidos** (en lugar de prohibidos).
16. Carga masiva de alumnos/tarjetas desde Excel/CSV.

## Multi-escuela (siguientes pasos)
30. **Cobro de la cuota** a cada escuela (Stripe/Mercado Pago con suscripción) y suspensión automática por falta de pago; hoy el plan es una nota.
31. Personalizar por escuela: logo, colores, nombre en la PWA y subdominio (`colegio.zuki.mx`).
32. ~~Bitácora del superadmin~~ (hecho en v2: *Bitácora*). Falta: acceso de "soporte" de solo lectura a una escuela y exportar la bitácora a CSV.
33. Reportes globales exportables (CSV/Excel) y gráfica de ventas por escuela en el panel del superadmin.
34. Mover una caja a otra escuela sin base nueva (hoy se exige base nueva para no mezclar datos) y transferir un alumno entre escuelas conservando historial.
35. Correo/SMS al crear la escuela con el acceso del administrador (hoy la contraseña temporal se muestra en pantalla).
36. Programar tarjetas: importar alumnos desde Excel antes de asignar, e imprimir etiquetas con el nombre para pegar en la tarjeta.

## Seguridad y técnica
17. **NTAG424 DNA** con validación SUN/SDM para impedir la clonación del UID.
18. Refresh token en **cookie HttpOnly + SameSite** en lugar de `localStorage`; 2FA opcional para administradores.
19. Bloqueo de pantalla del punto de venta por inactividad y PIN rápido para cambiar de cajero.
20. Bitácora: ya registra recargas, borrados, contraseñas, cuentas, accesos y emergencia. Falta registrar cambios de precio y hacer las alertas por correo/WhatsApp al superadmin (hoy solo se ven en el panel).
21. **Base de datos del servidor**: con muchas escuelas, migrar a PostgreSQL (con *row-level security* por `school_id` como segunda barrera) y límites de intentos en Redis para varias instancias.
22. Cifrado de la base local (SQLCipher) y del respaldo.
23. Actualizaciones automáticas de la app de escritorio (`electron-updater` + servidor de releases; requiere firma).
24. Lector PC/SC incluido en el instalador (compilar `nfc-pcsc` en cada plataforma) y pantalla de configuración del lector.
25. Pruebas E2E en CI (GitHub Actions con Windows, macOS y Linux) y build automático de instaladores.
26. Accesibilidad (teclado completo, contraste) e idioma configurable.
27. Excluir del paquete de escritorio las dependencias exclusivas del servidor (express, jsonwebtoken) para reducir tamaño.
28. Restaurar en la caja una base descargada del servidor (útil si se descompone la computadora sin respaldo).
29. Recargas en línea combinadas con la sincronización: el servidor debería enviar las recargas pagadas en línea a la caja (nuevo tipo de cambio en el pull) en lugar de rechazarlas.
