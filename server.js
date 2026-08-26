// server.js — Agente de ventas Dwinky (Valentina)
// Conecta WhatsApp Cloud API + Messenger + Instagram (todo vía Meta Graph API)
// y usa la API de Anthropic (Claude) como cerebro conversacional.

const express = require("express");
const axios = require("axios");
const { construirSystemPrompt } = require("./data");

const app = express();
app.use(express.json());
app.use(express.static("public")); // sirve el widget de chat (public/widget.html)

// ── Variables de entorno (configúralas en tu proveedor de hosting) ─────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;               // tú la inventas, ej: "dwinky2026"
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;           // token de WhatsApp Cloud API (Meta)
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;     // token de tu Página de Facebook (sirve para Messenger e Instagram)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;           // para enviarte el correo de notificación (resend.com)
const EMAIL_NOTIFICACIONES = process.env.EMAIL_NOTIFICACIONES || "hola@dwinky.com";
const WHATSAPP_DUENO = process.env.WHATSAPP_DUENO;            // tu número (con código de país, ej: 573235178058) para recibir la notificación por WhatsApp también

// ── Memoria de conversación en RAM (simple, se reinicia si el servidor reinicia) ──
// Para producción real, esto debería guardarse en una base de datos (Postgres, Redis, etc.)
const historiales = new Map(); // clave: id del usuario, valor: array de mensajes

function obtenerHistorial(id) {
  if (!historiales.has(id)) historiales.set(id, []);
  return historiales.get(id);
}

// ── 1. Verificación del webhook (Meta la pide una sola vez al configurar) ──
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── 2. Recepción de mensajes (WhatsApp, Messenger e Instagram llegan aquí) ──
// ── 2b. Chat desde la página web (widget de Dwinky en Lovable) ──
app.post("/chat", async (req, res) => {
  try {
    const { mensaje, sessionId } = req.body;
    if (!mensaje || !sessionId) {
      return res.status(400).json({ error: "Falta 'mensaje' o 'sessionId'." });
    }
    const respuesta = await generarRespuesta(`web-${sessionId}`, mensaje);
    res.json({ respuesta });
  } catch (err) {
    console.error("Error en /chat:", err.message);
    res.status(500).json({ error: "Valentina no pudo responder, intenta de nuevo." });
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta; procesamos después

  try {
    const body = req.body;

    // --- Mensajes de WhatsApp ---
    if (body.object === "whatsapp_business_account") {
      const entrada = body.entry?.[0]?.changes?.[0]?.value;
      const mensaje = entrada?.messages?.[0];

      if (mensaje && mensaje.type === "text") {
        const de = mensaje.from;
        const texto = mensaje.text.body;
        const respuesta = await generarRespuesta(de, texto);
        await enviarWhatsApp(de, respuesta);
      }

      // El cliente puede enviar su ubicación (pin) en vez de escribir la dirección.
      if (mensaje && mensaje.type === "location") {
        const de = mensaje.from;
        const { latitude, longitude, address, name } = mensaje.location;
        const mapa = `https://www.google.com/maps?q=${latitude},${longitude}`;
        // Se lo pasamos a Valentina como si fuera un mensaje de texto, para que lo use en el pedido.
        const textoUbicacion = `[El cliente compartió su ubicación de entrega]\nCoordenadas: ${latitude}, ${longitude}\nMapa: ${mapa}${address ? `\nDirección aproximada: ${address}` : ""}${name ? `\nLugar: ${name}` : ""}`;
        const respuesta = await generarRespuesta(de, textoUbicacion);
        await enviarWhatsApp(de, respuesta);
      }
    }

    // --- Mensajes de Messenger / Instagram ---
    if (body.object === "page" || body.object === "instagram") {
      const entrada = body.entry?.[0]?.messaging?.[0];
      if (entrada?.message?.text) {
        const de = entrada.sender.id;
        const texto = entrada.message.text;
        const respuesta = await generarRespuesta(de, texto);
        await enviarMeta(de, respuesta);
      }
    }
  } catch (err) {
    console.error("Error procesando webhook:", err.message);
  }
});

// ── 3. Cerebro: llamada a Claude con el guion de ventas + memoria del cliente ──
async function generarRespuesta(idUsuario, textoEntrante) {
  const historial = obtenerHistorial(idUsuario);
  historial.push({ role: "user", content: textoEntrante });

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: construirSystemPrompt(),
      messages: historial,
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const textoCompleto = resp.data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n") || "Disculpa, ¿me repites eso? 🙏";

  // Guardamos la respuesta completa (con el bloque técnico) en el historial,
  // para que el modelo recuerde que ya generó ese pedido si el cliente sigue escribiendo.
  historial.push({ role: "assistant", content: textoCompleto });

  // Separamos el bloque técnico [[DATOS_JSON]]...[[/DATOS_JSON]] del mensaje visible.
  const { textoVisible, datos } = extraerDatosOcultos(textoCompleto);

  if (datos) {
    notificarPorCorreo(datos).catch((e) =>
      console.error("No se pudo enviar la notificación por correo:", e.message)
    );
    notificarPorWhatsApp(datos).catch((e) =>
      console.error("No se pudo enviar la notificación por WhatsApp:", e.message)
    );
  }

  return textoVisible;
}

// Quita el bloque técnico del texto que ve el cliente y devuelve los datos parseados.
function extraerDatosOcultos(texto) {
  const match = texto.match(/\[\[DATOS_JSON\]\]([\s\S]*?)\[\[\/DATOS_JSON\]\]/);
  if (!match) return { textoVisible: texto, datos: null };

  const textoVisible = texto.replace(match[0], "").trim();
  let datos = null;
  try {
    datos = JSON.parse(match[1].trim());
  } catch (e) {
    console.error("No se pudo interpretar el bloque de datos del pedido:", e.message);
  }
  return { textoVisible, datos };
}

// Envía un correo con los datos del pedido o visita usando la API de Resend.
async function notificarPorCorreo(datos) {
  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY no configurada — datos capturados pero no se envió correo:", datos);
    return;
  }

  const esVisita = datos.tipo_evento === "visita";
  const asunto = esVisita
    ? `📅 Nueva visita agendada — ${datos.nombre || "cliente"}`
    : `🍦 Nuevo pedido ${datos.codigo || ""} — ${datos.nombre || "cliente"}`;

  const cuerpo = esVisita
    ? `
      <h2>Nueva visita agendada</h2>
      <p><b>Nombre:</b> ${datos.nombre || "-"}</p>
      <p><b>Negocio:</b> ${datos.nombre_negocio || "-"} (${datos.tipo_negocio || "-"})</p>
      <p><b>Dirección:</b> ${datos.direccion || "-"}</p>
      <p><b>Teléfono:</b> ${datos.telefono || "-"}</p>
      <p><b>Horario preferido:</b> ${datos.horario_preferido || "-"}</p>
    `
    : `
      <h2>Nuevo pedido: ${datos.codigo || "-"}</h2>
      <p><b>Cliente:</b> ${datos.nombre || "-"}</p>
      <p><b>Teléfono:</b> ${datos.telefono || "-"}</p>
      <p><b>Entrega:</b> ${datos.entrega || "-"} ${datos.direccion ? "— " + datos.direccion : ""}</p>
      <p><b>Sabores:</b> ${(datos.sabores || []).map(s => `${s.cantidad}x ${s.sabor}`).join(", ")}</p>
      <p><b>Total:</b> $${(datos.total || 0).toLocaleString("es-CO")}</p>
      <p><b>Pago:</b> ${datos.metodo_pago || "-"}</p>
      ${datos.es_mayorista ? `<p><b>Mayorista</b> — tipo de negocio: ${datos.tipo_negocio || "-"}</p>` : ""}
    `;

  await axios.post(
    "https://api.resend.com/emails",
    {
      from: "Valentina (Dwinky) <pedidos@dwinky-notificaciones.com>", // ajusta con tu dominio verificado en Resend
      to: EMAIL_NOTIFICACIONES,
      subject: asunto,
      html: cuerpo,
    },
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } }
  );
}

// Envía un resumen por WhatsApp al número del dueño (ver limitación de la ventana de 24h en el README).
async function notificarPorWhatsApp(datos) {
  if (!WHATSAPP_DUENO) {
    console.log("WHATSAPP_DUENO no configurado — no se envió notificación por WhatsApp.");
    return;
  }

  const esVisita = datos.tipo_evento === "visita";
  const texto = esVisita
    ? `📅 *Nueva visita agendada*\n${datos.nombre || "-"}\nNegocio: ${datos.nombre_negocio || "-"} (${datos.tipo_negocio || "-"})\nDirección: ${datos.direccion || "-"}\nTeléfono: ${datos.telefono || "-"}\nHorario preferido: ${datos.horario_preferido || "-"}`
    : `🍦 *Nuevo pedido ${datos.codigo || ""}*\n${datos.nombre || "-"} — ${datos.telefono || "-"}\n${datos.entrega || "-"}${datos.direccion ? ": " + datos.direccion : ""}\n${(datos.sabores || []).map(s => `${s.cantidad}x ${s.sabor}`).join(", ")}\nTotal: $${(datos.total || 0).toLocaleString("es-CO")}\nPago: ${datos.metodo_pago || "-"}${datos.es_mayorista ? `\n⚠️ Mayorista (${datos.tipo_negocio || "-"})` : ""}`;

  await enviarWhatsApp(WHATSAPP_DUENO, texto);
}

// ── 4. Envío de respuesta por WhatsApp ──
async function enviarWhatsApp(para, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: para,
      text: { body: texto },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ── 5. Envío de respuesta por Messenger / Instagram ──
async function enviarMeta(para, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: para },
      message: { text: texto },
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente Dwinky escuchando en el puerto ${PORT}`));
