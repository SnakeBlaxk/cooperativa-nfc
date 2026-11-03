'use strict';
// Ayuda dentro de la app: preguntas frecuentes y asistente de IA (solo sobre el uso de Zuki Pay).
// Los textos usan términos escolares; para cuentas 'natacion' se traducen (Alumno→Nadador, etc.).
const SUPPORT_WA = 'https://wa.me/5215658629519';
// only: 'natacion' = solo academias de natación; 'escuela' = solo escuelas; sin valor = todas
const FAQ = [
  { q: '¿Cómo registro un alumno?', a: 'Menú Alumnos y padres → "+ Alumno". Escriba el nombre completo y el grado y grupo, elija al tutor (o déjelo vacío para vincularlo después con un código de invitación) y guarde. Puede agregar una foto opcional.' },
  { q: '¿Cómo registro a un papá o tutor?', a: 'Alumnos y padres → "+ Tutor". Capture nombre, correo o teléfono y WhatsApp (si lo deja vacío se usa el teléfono). Se genera una contraseña temporal que se le envía. También puede darle al tutor un código de invitación desde el botón "Invitación" del alumno.' },
  { q: '¿Cómo edito o doy de baja a un alumno?', a: 'Alumnos y padres → botón "Editar" del alumno para cambiar datos o marcarlo inactivo. "Eliminar alumno" lo manda a la Papelera (se puede restaurar) y permite reembolsar el saldo.' },
  { q: '¿Cómo asigno una tarjeta NFC?', a: 'En Alumnos y padres toque "🪪 Asignar tarjeta" (o Tarjeta en el perfil). Acerque la tarjeta al lector o escriba su número (UID). Para varios alumnos a la vez use Programar tarjetas.' },
  { q: '¿Qué hago si se pierde una tarjeta?', a: 'En el perfil del alumno → Tarjeta y perfil → "Reportar perdida y reemplazar". El saldo pasa a la tarjeta nueva. También puede bloquearla temporalmente.' },
  { q: '¿Cómo recargo saldo?', a: 'Menú Recargas: acerque la tarjeta o búsquela, escriba el monto y confirme. El papá ve la recarga en su app.' },
  { q: '¿Cómo agrego productos a la cooperativa?', a: 'Menú Productos → "+ Producto": nombre, categoría, precio y, si quiere, existencias y mínimo para avisos de inventario.' },
  { q: '¿Cómo cobro con la tarjeta?', a: 'Menú Cobrar: toque los productos, luego acerque la tarjeta del alumno. Se valida saldo, límites y productos prohibidos y se descuenta al momento. Si fue un error, "Cancelar venta" en Movimientos regresa el saldo.' },
  { q: '¿Dónde veo reportes y movimientos?', a: 'Resumen muestra ventas y recargas del día. Reportes da ventas por periodo y producto (se puede exportar). Movimientos lista cada compra, recarga y ajuste.' },
  { q: '¿Cómo doy de alta personal (cajero)?', a: 'Configuración → Personal → nuevo usuario con puesto Cajero. El cajero solo cobra y recarga.' },
  { q: '¿Quién cambia las contraseñas?', a: 'Por seguridad solo el administrador de la plataforma (Zuki Company). Pida el cambio con el botón Ayuda → WhatsApp.' },
  { q: '¿Los papás pueden poner límites?', a: 'Sí. Desde su app el papá o tutor pone límite por compra, por día o por periodo y productos prohibidos. La escuela solo los consulta.' },
  { only: 'natacion', q: '¿Cómo configuro la mensualidad de un alumno?', a: 'Alumnos y padres → Editar: elija "Días por semana" (1 a 6) y la "Fecha de inicio". La mensualidad sale de la tabla de precios: 1 día $330, 2 $470, 3 $600, 4 $750, 5 $840, 6 $920 (editable en Mensualidades → Precios de la academia).' },
  { only: 'natacion', q: '¿Cuándo vence la mensualidad?', a: 'Cada mes el mismo día de la fecha de inicio; si el mes es más corto, el último día del mes. Estados: Al corriente, Por vencer (3 días o menos) y Vencida.' },
  { only: 'natacion', q: '¿Cómo registro un pago de mensualidad?', a: 'Perfil del alumno → pestaña Mensualidad → "Registrar pago" (o desde el menú Mensualidades). El monto viene prellenado; elija fecha y nota opcional. El siguiente vencimiento avanza un mes. Es un registro manual: no se descuenta de la tarjeta.' },
  { only: 'natacion', q: '¿Cómo borro o corrijo un pago registrado por error?', a: 'Perfil del alumno → Mensualidad → Historial de pagos → "Editar" para corregir monto, fecha o nota, o "Borrar" (pide confirmación). Al borrar, el vencimiento regresa un mes.' },
  { only: 'natacion', q: '¿Cómo registro la inscripción?', a: 'Al crear o editar al alumno marque "Inscripción pagada", o en la pestaña Mensualidad use "Marcar pagada hoy". El costo de inscripción ($200 por defecto) se cambia en Mensualidades → Precios de la academia.' },
  { only: 'natacion', q: '¿Cómo veo quién debe?', a: 'Menú Mensualidades: la lista filtra Vencidas y por vencer, Al corriente, Sin mensualidad o Todos, con el tutor y su WhatsApp.' },
  { q: '¿Están seguros los datos?', a: 'Sí. La información se guarda en el servidor con acceso por usuario y contraseña, bitácora de cambios y respaldos. No comparta su contraseña.' },
];
const TERMS = {
  natacion: [[/Cooperativa escolar|Tiendita escolar/g, 'Tiendita'], [/cooperativa/g, 'tiendita'], [/Cooperativa/g, 'Tiendita'], [/Alumnos/g, 'Nadadores'], [/alumnos/g, 'nadadores'], [/Alumno/g, 'Nadador'], [/alumno/g, 'nadador'],
    [/Escuelas/g, 'Academias'], [/escuelas/g, 'academias'], [/Escuela/g, 'Academia'], [/escuela/g, 'academia'], [/grado y grupo/gi, 'nivel/horario']],
};
const terms = (t, type) => (TERMS[type] || []).reduce((s, [re, r]) => s.replace(re, r), t);
function faqFor(type = 'escuela') { return FAQ.filter((f) => !f.only || f.only === type); }
function systemPrompt(type = 'escuela', schoolName = '') {
  const guide = faqFor(type).map((f) => `- ${terms(f.q, type)} ${terms(f.a, type)}`).join('\n');
  const vocab = type === 'natacion' ? 'Esta cuenta es una academia de natación: di "nadador" (no alumno), "academia" (no escuela), "nivel/horario" (no grado y grupo) y "tiendita" (no cooperativa).' : 'Esta cuenta es una escuela con cooperativa escolar.';
  return `Eres el asistente de ayuda de Zuki Pay (Zuki Company), una app de pagos con tarjetas NFC para cooperativas escolares y academias. ${vocab} Cuenta: ${schoolName || 'sin nombre'}.
Responde SIEMPRE en español de México, breve (máximo 5 líneas o pasos numerados), amable y claro. Solo responde sobre cómo usar Zuki Pay. Si preguntan otra cosa, di amablemente que solo ayudas con Zuki Pay. No inventes funciones: si algo no está en la guía o no sabes, sugiere escribir a soporte por WhatsApp (+52 56 5862 9519). Nunca pidas ni reveles contraseñas.
Guía de uso:
${guide}`;
}

// Asistente de IA (servidor). Llave en ZUKIPAY_AI_API_KEY (o OPENAI_API_KEY); API compatible con OpenAI.
function createHelpAI({ env = process.env, fetchImpl = globalThis.fetch, limit = 20, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map(); // límite por cuenta (escuela)
  const key = () => env.ZUKIPAY_AI_API_KEY || env.OPENAI_API_KEY || '';
  function allow(k) {
    const t = Date.now(); const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) { hits.set(k, arr); return false; }
    arr.push(t); hits.set(k, arr); return true;
  }
  async function chat({ user, messages, schoolName, type }) {
    if (!key()) return { configured: false, support_url: SUPPORT_WA };
    const msgs = (Array.isArray(messages) ? messages : []).slice(-8)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw Object.assign(new Error('Escriba su pregunta'), { code: 'VALIDACION' });
    if (!allow(String(user.school_id || 'u' + user.id))) throw Object.assign(new Error('Ya hizo muchas preguntas en la última hora. Intente más tarde o escriba a soporte por WhatsApp.'), { code: 'LIMITE' });
    const base = (env.ZUKIPAY_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetchImpl(base + '/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.ZUKIPAY_AI_MODEL || 'gpt-4o-mini', max_tokens: 400, temperature: 0.3, messages: [{ role: 'system', content: systemPrompt(type, schoolName) }, ...msgs] }) });
      if (!r.ok) throw new Error('IA ' + r.status);
      const j = await r.json();
      const answer = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!answer) throw new Error('IA sin respuesta');
      return { configured: true, answer: String(answer).trim(), support_url: SUPPORT_WA };
    } catch (e) {
      console.warn('[ayuda-ia]', e.message);
      throw Object.assign(new Error('El asistente no está disponible en este momento. Escriba a soporte por WhatsApp.'), { code: 'IA_NO_DISPONIBLE' });
    } finally { clearTimeout(timer); }
  }
  return { chat, configured: () => !!key() };
}
module.exports = { FAQ, faqFor, systemPrompt, createHelpAI, SUPPORT_WA, terms };
