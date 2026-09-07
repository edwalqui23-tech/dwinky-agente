// server.js - Agente de ventas Dwinky (Valentina)
// Conecta WhatsApp Cloud API + Messenger + Instagram (todo via Meta Graph API)
// y usa la API de Anthropic (Claude) como cerebro conversacional.
// Ademas guarda clientes, conversaciones y pedidos en PostgreSQL para el panel de control.

const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const { construirSystemPrompt } = require("./data");

const app = express();
app.use(express.json());
app.use(express.static("public")); // sirve el widget de chat y el panel (public/)

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
const DATABASE_URL = process.env.DATABASE_URL;
const PANEL_USUARIO = process.env.PANEL_USUARIO || "admin";
const PANEL_CLAVE = process.env.PANEL_CLAVE || "dwinky2026";

// -- Conexion a PostgreSQL --
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : false,
});

async function inicializarBaseDatos() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL no configurada - el panel de control no guardara datos.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id_usuario TEXT PRIMARY KEY,
      canal TEXT NOT NULL,
      nombre TEXT,
      telefono TEXT,
      direccion TEXT,
      estado TEXT NOT NULL DEFAULT 'nuevo',
      total_comprado NUMERIC NOT NULL DEFAULT 0,
      num_pedidos INTEGER NOT NULL DEFAULT 0,
      primer_contacto TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultimo_contacto TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id SERIAL PRIMARY KEY,
      id_usuario TEXT NOT NULL,
      canal TEXT NOT NULL,
      remitente TEXT NOT NULL,
      mensaje TEXT,
      fecha TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      id_usuario TEXT NOT NULL,
      canal TEXT NOT NULL,
      codigo TEXT,
      tipo_evento TEXT,
      nombre TEXT,
      telefono TEXT,
      direccion TEXT,
      entrega TEXT,
      sabores JSONB,
      total NUMERIC NOT NULL DEFAULT 0,
      metodo_pago TEXT,
      es_mayorista BOOLEAN NOT NULL DEFAULT false,
      tipo_negocio TEXT,
      fecha TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("Base de datos lista (clientes, conversaciones, pedidos).");
}

// Registra o actualiza el "ultimo contacto" de un cliente. Se llama en cada mensaje.
async function guardarCliente(idUsuario, canal) {
  if (!DATABASE_URL) return;
  try {
    await pool.query(
      `INSERT INTO clientes (id_usuario, canal, ultimo_contacto)
       VALUES ($1, $2, now())
       ON CONFLICT (id_usuario)
       DO UPDATE SET ultimo_contacto = now()`,
      [idUsuario, canal]
    );
  } catch (e) {
    console.error("No se pudo guardar/actualizar el cliente:", e.message);
  }
}

// Guarda un mensaje (del cliente o de Valentina) en el historial de conversaciones.
async function guardarMensaje(idUsuario, canal, remitente, mensaje) {
  if (!DATABASE_URL) return;
  try {
    await pool.query(
      `INSERT INTO conversaciones (id_usuario, canal, remitente, mensaje) VALUES ($1, $2, $3, $4)`,
      [idUsuario, canal, remitente, mensaje]
    );
  } catch (e) {
    console.error("No se pudo guardar el mensaje:", e.message);
  }
}

// Guarda un pedido o visita cerrada, y actualiza el resumen del cliente.
async function guardarPedidoEnBD(datos, idUsuario, canal) {
  if (!DATABASE_URL) return;
  try {
    const total = datos.total || 0;
    await pool.query(
      `INSERT INTO pedidos
        (id_usuario, canal, codigo, tipo_evento, nombre, telefono, direccion, entrega, sabores, total, metodo_pago, es_mayorista, tipo_negocio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        idUsuario,
        canal,
        datos.codigo || null,
        datos.tipo_evento || "pedido",
        datos.nombre || null,
        datos.telefono || null,
        datos.direccion || null,
        datos.entrega || null,
        JSON.stringify(datos.sabores || []),
        total,
        datos.metodo_pago || null,
        !!datos.es_mayorista,
        datos.tipo_negocio || null,
      ]
    );
    await pool.query(
      `INSERT INTO clientes (id_usuario, canal, nombre, telefono, direccion, estado, total_comprado, num_pedidos, ultimo_contacto)
       VALUES ($1,$2,$3,$4,$5,'cerrado',$6,1, now())
       ON CONFLICT (id_usuario)
       DO UPDATE SET
         nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
         telefono = COALESCE(EXCLUDED.telefono, clientes.telefono),
         direccion = COALESCE(EXCLUDED.direccion, clientes.direccion),
         estado = 'cerrado',
         total_comprado = clientes.total_comprado + $6,
         num_pedidos = clientes.num_pedidos + 1,
         ultimo_contacto = now()`,
      [idUsuario, canal, datos.nombre || null, datos.telefono || null, datos.direccion || null, total]
    );
  } catch (e) {
    console.error("No se pudo guardar el pedido en la base de datos:", e.message);
  }
}

// -- Memoria de conversacion en RAM (para el contexto que ve Claude) --
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
    const respuesta = await generarRespuesta("web-" + sessionId, mensaje, "web");
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
        const respuesta = await generarRespuesta(de, texto, "whatsapp");
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
        const respuesta = await generarRespuesta(de, textoUbicacion, "whatsapp");
        await enviarWhatsApp(de, respuesta);
      }
    }

    if (body.object === "page" || body.object === "instagram") {
      const canal = body.object === "instagram" ? "instagram" : "messenger";
      const entrada = body.entry && body.entry[0] && body.entry[0].messaging && body.entry[0].messaging[0];
      if (entrada && entrada.message && entrada.message.text) {
        const de = entrada.sender.id;
        const texto = entrada.message.text;
        const respuesta = await generarRespuesta(de, texto, canal);
        await enviarMeta(de, respuesta);
      }
    }
  } catch (err) {
    console.error("Error procesando webhook:", err.message);
  }
});

// -- 3. Cerebro: llamada a Claude con el guion de ventas + memoria del cliente --
async function generarRespuesta(idUsuario, textoEntrante, canal) {
  const historial = obtenerHistorial(idUsuario);
  historial.push({ role: "user", content: textoEntrante });

  guardarCliente(idUsuario, canal).catch(function (e) {
    console.error("Error guardando cliente:", e.message);
  });
  guardarMensaje(idUsuario, canal, "cliente", textoEntrante).catch(function (e) {
    console.error("Error guardando mensaje del cliente:", e.message);
  });

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

  guardarMensaje(idUsuario, canal, "valentina", textoVisible).catch(function (e) {
    console.error("Error guardando mensaje de Valentina:", e.message);
  });

  if (datos) {
    guardarPedidoEnBD(datos, idUsuario, canal).catch(function (e) {
      console.error("No se pudo guardar el pedido en la base de datos:", e.message);
    });
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

// -- 6. Panel de control: proteccion con usuario/clave simple --
function protegerPanel(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth.indexOf("Basic ") !== 0) {
    res.set("WWW-Authenticate", 'Basic realm="Panel Dwinky"');
    return res.status(401).send("Acceso restringido.");
  }
  const credenciales = Buffer.from(auth.split(" ")[1], "base64").toString();
  const partes = credenciales.split(":");
  const usuario = partes[0];
  const clave = partes[1];
  if (usuario === PANEL_USUARIO && clave === PANEL_CLAVE) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Panel Dwinky"');
  return res.status(401).send("Usuario o clave incorrectos.");
}

app.get("/panel", protegerPanel, function (req, res) {
  res.sendFile(__dirname + "/public/panel.html");
});

// Estadisticas generales: conversaciones, pedidos, tasa de cierre, por canal, sabores mas vendidos.
app.get("/api/estadisticas", protegerPanel, async function (req, res) {
  if (!DATABASE_URL) return res.status(500).json({ error: "Base de datos no configurada." });
  try {
    const totalClientes = await pool.query("SELECT COUNT(*) FROM clientes");
    const totalPedidos = await pool.query("SELECT COUNT(*), COALESCE(SUM(total),0) as ingresos FROM pedidos WHERE tipo_evento = 'pedido'");
    const porCanal = await pool.query(
      "SELECT canal, COUNT(*) as total FROM clientes GROUP BY canal ORDER BY total DESC"
    );
    const porEstado = await pool.query(
      "SELECT estado, COUNT(*) as total FROM clientes GROUP BY estado ORDER BY total DESC"
    );
    const saboresRes = await pool.query(
      "SELECT sabores FROM pedidos WHERE tipo_evento = 'pedido' AND sabores IS NOT NULL"
    );
    const conteoSabores = {};
    saboresRes.rows.forEach(function (fila) {
      (fila.sabores || []).forEach(function (s) {
        if (!s || !s.sabor) return;
        conteoSabores[s.sabor] = (conteoSabores[s.sabor] || 0) + (s.cantidad || 0);
      });
    });
    const saboresTop = Object.entries(conteoSabores)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 8)
      .map(function (e) { return { sabor: e[0], cantidad: e[1] }; });

    const totalClientesNum = parseInt(totalClientes.rows[0].count, 10);
    const totalPedidosNum = parseInt(totalPedidos.rows[0].count, 10);

    res.json({
      total_clientes: totalClientesNum,
      total_pedidos: totalPedidosNum,
      ingresos_totales: parseFloat(totalPedidos.rows[0].ingresos),
      tasa_cierre: totalClientesNum > 0 ? Math.round((totalPedidosNum / totalClientesNum) * 100) : 0,
      por_canal: porCanal.rows,
      por_estado: porEstado.rows,
      sabores_top: saboresTop,
    });
  } catch (e) {
    console.error("Error en /api/estadisticas:", e.message);
    res.status(500).json({ error: "No se pudieron calcular las estadisticas." });
  }
});

// Lista de clientes con su estado, para ver quien cerro, quien quedo a medias, etc.
app.get("/api/clientes", protegerPanel, async function (req, res) {
  if (!DATABASE_URL) return res.status(500).json({ error: "Base de datos no configurada." });
  try {
    const resultado = await pool.query(
      `SELECT id_usuario, canal, nombre, telefono, direccion, estado, total_comprado, num_pedidos, primer_contacto, ultimo_contacto
       FROM clientes
       ORDER BY ultimo_contacto DESC
       LIMIT 300`
    );
    res.json(resultado.rows);
  } catch (e) {
    console.error("Error en /api/clientes:", e.message);
    res.status(500).json({ error: "No se pudo obtener la lista de clientes." });
  }
});

// Historial completo de mensajes de un cliente especifico (para retomar la conversacion).
app.get("/api/clientes/:id/conversacion", protegerPanel, async function (req, res) {
  if (!DATABASE_URL) return res.status(500).json({ error: "Base de datos no configurada." });
  try {
    const resultado = await pool.query(
      `SELECT remitente, mensaje, fecha FROM conversaciones WHERE id_usuario = $1 ORDER BY fecha ASC`,
      [req.params.id]
    );
    res.json(resultado.rows);
  } catch (e) {
    console.error("Error en /api/clientes/:id/conversacion:", e.message);
    res.status(500).json({ error: "No se pudo obtener la conversacion." });
  }
});

const PORT = process.env.PORT || 3000;
inicializarBaseDatos()
  .catch(function (e) {
    console.error("Error inicializando la base de datos:", e.message);
  })
  .finally(function () {
    app.listen(PORT, function () {
      console.log("Agente Dwinky escuchando en el puerto " + PORT);
    });
  });
