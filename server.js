// server.js - Agente de ventas Dwinky (Valentina)
// Conecta WhatsApp Cloud API + Messenger + Instagram (todo via Meta Graph API)
// y usa la API de Anthropic (Claude) como cerebro conversacional.

const express = require("express");
const axios = require("axios");
const { construirSystemPrompt } = require("./data");

const app = express();
app.use(express.json());
app.use(express.static("public")); // sirve el widget de chat (public/widget.html)

// -- Variables de entorno (configuralas en tu proveedor de hosting) --
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_NOTIFICACIONES = process.env.EMAIL_NOTIFICACIONES || "hola@dwinky.com";
const WHATSAPP_DUENO = process.env.WHATSAPP_DUENO;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -- Memoria de conversacion en RAM --
const historiales = new Map();

function obtenerHistorial(id) {
  if (!historiales.has(id)) historiales.set(id, []);
  return historiales.get(id);
}

// -- 1. Verificacion del webhook (Meta la pide una sola vez al configurar) --
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

// -- 2b. Chat desde la pagina web (widget de Dwinky en Lovable) --
app.post("/chat", async (req, res) => {
  try {
    const mensaje = req.body.mensaje;
    const sessionId = req.body.sessionId;
    if (!mensaje || !sessionId) {
      return res.status(400).json({ error: "Falta 'mensaje' o 'sessionId'." });
    }
    const respuesta = await generarRespuesta("web-" + sessionId, mensaje);
    res.json({ respuesta: respuesta });
  } catch (err) {
    console.error("Error en /chat:", err.message);
    res.status(500).json({ error: "Valentina no pudo responder, intenta de nuevo." });
  }
});

// -- 2. Recepcion de mensajes (WhatsApp, Messenger e Instagram llegan aqui) --
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      const entrada = body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
      const mensaje = entrada && entrada.messages && entrada.messages[0];

      if (mensaje && mensaje.type === "text") {
        const de = mensaje.from;
        const texto = mensaje.text.body;
        const respuesta = await generarRespuesta(de, texto);
        await enviarWhatsApp(de, respuesta);
      }

      if (mensaje && mensaje.type === "location") {
        const de = mensaje.from;
        const latitude = mensaje.location.latitude;
        const longitude = mensaje.location.longitude;
        const address = mensaje.location.address;
        const name = mensaje.location.name;
        const mapa = "https://www.google.com/maps?q=" + latitude + "," + longitude;
        let textoUbicacion = "[El cliente compartio su ubicacion de entrega]\nCoordenadas: " + latitude + ", " + longitude + "\nMapa: " + mapa;
        if (address) textoUbicacion += "\nDireccion aproximada: " + address;
        if (name) textoUbicacion += "\nLugar: " + name;
        const respuesta = await generarRespuesta(de, textoUbicacion);
        await enviarWhatsApp(de, respuesta);
      }
    }

    if (body.object === "page" || body.object === "instagram") {
      const entrada = body.entry && body.entry[0] && body.entry[0].messaging && body.entry[0].messaging[0];
      if (entrada && entrada.message && entrada.message.text) {
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

// -- 3. Cerebro: llamada a Claude con el guion de ventas + memoria del cliente --
async function generarRespuesta(idUsuario, textoEntrante) {
  const historial = obtenerHistorial(idUsuario);
  historial.push({ role: "user", content: textoEntrante });

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 700,
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
    .filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; })
    .join("\n") || "Disculpa, me repites eso?";

  historial.push({ role: "assistant", content: textoCompleto });

  const resultado = extraerDatosOcultos(textoCompleto);
  const textoVisible = resultado.textoVisible;
  const datos = resultado.datos;

  if (datos) {
    notificarPorCorreo(datos).catch(function (e) {
      console.error("No se pudo enviar la notificacion por correo:", e.message);
    });
    notificarPorWhatsApp(datos).catch(function (e) {
      console.error("No se pudo enviar la notificacion por WhatsApp:", e.message);
    });
    notificarPorTelegram(datos).catch(function (e) {
      console.error("No se pudo enviar la notificacion por Telegram:", e.message);
    });
  }

  return textoVisible;
}

// Quita el bloque tecnico del texto que ve el cliente y devuelve los datos parseados.
function extraerDatosOcultos(texto) {
  console.log("[DEBUG] Respuesta completa de Valentina:", texto);
  const match = texto.match(/\[\[DATOS_JSON\]\]([\s\S]*?)\[\[\/DATOS_JSON\]\]/);
  if (!match) return { textoVisible: texto, datos: null };

  const textoVisible = texto.replace(match[0], "").trim();
  let datos = null;
  try {
    datos = JSON.parse(match[1].trim());
  } catch (e) {
    console.error("No se pudo interpretar el bloque de datos del pedido:", e.message);
  }
  return { textoVisible: textoVisible, datos: datos };
}

function formatearResumen(datos) {
  const esVisita = datos.tipo_evento === "visita";
  if (esVisita) {
    return {
      titulo: "Nueva visita agendada",
      lineas: [
        "Nombre: " + (datos.nombre || "-"),
        "Negocio: " + (datos.nombre_negocio || "-") + " (" + (datos.tipo_negocio || "-") + ")",
        "Direccion: " + (datos.direccion || "-"),
        "Telefono: " + (datos.telefono || "-"),
        "Horario preferido: " + (datos.horario_preferido || "-"),
      ],
    };
  }
  const sabores = (datos.sabores || []).map(function (s) { return s.cantidad + "x " + s.sabor; }).join(", ");
  const lineas = [
    "Cliente: " + (datos.nombre || "-"),
    "Telefono: " + (datos.telefono || "-"),
    "Entrega: " + (datos.entrega || "-") + (datos.direccion ? " - " + datos.direccion : ""),
    "Sabores: " + sabores,
    "Total: $" + (datos.total || 0).toLocaleString("es-CO"),
    "Pago: " + (datos.metodo_pago || "-"),
  ];
  if (datos.es_mayorista) lineas.push("Mayorista - tipo de negocio: " + (datos.tipo_negocio || "-"));
  return { titulo: "Nuevo pedido " + (datos.codigo || ""), lineas: lineas };
}

// Envia un correo con los datos del pedido o visita usando la API de Resend.
async function notificarPorCorreo(datos) {
  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY no configurada - datos capturados pero no se envio correo:", datos);
    return;
  }

  const resumen = formatearResumen(datos);
  const asunto = resumen.titulo + " - " + (datos.nombre || "cliente");
  const cuerpo = "<h2>" + resumen.titulo + "</h2>" + resumen.lineas.map(function (l) { return "<p>" + l + "</p>"; }).join("");

  await axios.post(
    "https://api.resend.com/emails",
    {
      from: "Valentina (Dwinky) <onboarding@resend.dev>",
      to: EMAIL_NOTIFICACIONES,
      subject: asunto,
      html: cuerpo,
    },
    { headers: { Authorization: "Bearer " + RESEND_API_KEY } }
  );
}

// Envia un resumen por WhatsApp al numero del dueno (requiere WhatsApp oficial conectado).
async function notificarPorWhatsApp(datos) {
  if (!WHATSAPP_DUENO) {
    console.log("WHATSAPP_DUENO no configurado - no se envio notificacion por WhatsApp.");
    return;
  }
  const resumen = formatearResumen(datos);
  const texto = resumen.titulo + "\n" + resumen.lineas.join("\n");
  await enviarWhatsApp(WHATSAPP_DUENO, texto);
}

// Envia un resumen por Telegram al chat configurado - no depende de Meta para nada.
async function notificarPorTelegram(datos) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados - no se envio notificacion por Telegram.");
    return;
  }
  const resumen = formatearResumen(datos);
  const texto = resumen.titulo + "\n" + resumen.lineas.join("\n");

  await axios.post("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: texto,
  });
}

// -- 4. Envio de respuesta por WhatsApp --
async function enviarWhatsApp(para, texto) {
  await axios.post(
    "https://graph.facebook.com/v19.0/" + WHATSAPP_PHONE_NUMBER_ID + "/messages",
    {
      messaging_product: "whatsapp",
      to: para,
      text: { body: texto },
    },
    { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN } }
  );
}

// -- 5. Envio de respuesta por Messenger / Instagram --
async function enviarMeta(para, texto) {
  await axios.post(
    "https://graph.facebook.com/v19.0/me/messages?access_token=" + PAGE_ACCESS_TOKEN,
    {
      recipient: { id: para },
      message: { text: texto },
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("Agente Dwinky escuchando en el puerto " + PORT);
});
