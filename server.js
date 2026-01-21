process.env.TZ = 'America/Mexico_City';

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const crypto = require("crypto");
const cors = require("cors");
const fetch = require("node-fetch");
const { type } = require("os");


// -----------------------------------------------
// FIREBASE
// -----------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert({
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    project_id: process.env.FIREBASE_PROJECT_ID
  }),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// -----------------------------------------------
// EXPRESS
// -----------------------------------------------
const app = express();
app.use(bodyParser.json());
app.use(cors());

// -----------------------------------------------
// UTILS
// -----------------------------------------------
function generarToken() {
  return crypto.randomBytes(24).toString("hex");
}
// -----------------------------------------------
// Es finm de semana
// -----------------------------------------------
function esFinDeSemana() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}
// -----------------------------------------------
// WEBHOOK VERIFY
// -----------------------------------------------
app.get("/webhook-whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// -----------------------------------------------
// WEBHOOK MENSAJES
// -----------------------------------------------
app.post("/webhook-whatsapp", async (req, res) => {
  try {

    const body = req.body;

    //console.log("Body recibido:", JSON.stringify(body, null, 2));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObj = value?.messages?.[0];

    if (!messageObj) {
 
      return res.sendStatus(200);
    }
    //const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    //if (!message) return res.sendStatus(200);
    const from = `+${messageObj.from}`;           // número sin whatsapp:
    const msgType = messageObj.type;        // text, location, image, etc.

    //const from = message.from;
    const type = messageObj.type;
    let message = "";

    if (msgType === "text") {
      message = messageObj.text.body.toLowerCase().trim();
    }

    // console.log("Tipo de mensaje:", msgType);
    // console.log("Contenido del mensaje:", message);
    // console.log("Número:", from);

    const empleadoSnap = await db.ref(`empleados/${from}`).once("value");
    if (!empleadoSnap.exists()) {
      await sendWhatsAppMessage(from, "❌ Tu número no está registrado.");
      return res.sendStatus(200);
    }
    const empleado = empleadoSnap.val();

    // CONVERSACIÓN
    const convSnap = await db.ref(`conversaciones/${from}`).once("value");
    const conv = convSnap.val();

    // -------------------------------
    // FLUJO DE JUSTIFICACIONES
    // -------------------------------
    if (conv?.estado === "MOTIVO_ENTRADA") {
      await db.ref(`checadas/${conv.checadaId}/justificacion`).update({
        motivo: text
      });

      await db.ref(`conversaciones/${from}`).update({
        estado: "AUTORIZADO_POR"
      });

      await sendWhatsApp(from, "👤 ¿Quién autorizó tu llegada tarde?");
      return res.sendStatus(200);
    }

    if (conv?.estado === "AUTORIZADO_POR") {
      await db.ref(`checadas/${conv.checadaId}/justificacion`).update({
        autorizadoPor: text,
        fecha: Date.now()
      });

      await db.ref(`conversaciones/${from}`).remove();

      await sendWhatsApp(from, "✅ Justificación registrada.");
      return res.sendStatus(200);
    }

    if (conv?.estado === "MOTIVO_SALIDA") {
      await db.ref(`checadas/${conv.checadaId}/justificacion`).set({
        motivo: text,
        fecha: Date.now()
      });

      await db.ref(`conversaciones/${from}`).remove();

      await sendWhatsApp(from, "✅ Motivo de salida tarde registrado.");
      return res.sendStatus(200);
    }

    // -----------------------------------------------
    // COMANDOS DE CHECADA
    // -----------------------------------------------
    console.log("tipo de mensaje:", type);
    if (type === "text") {
      const text = messageObj.text.body.toLowerCase().trim();;

      if (text === "entrada" || text === "salida") {
        console.log(`Iniciando checada de tipo: ${text.toUpperCase()}`);
        await iniciarChecada(from, empleado, text.toUpperCase());
      } else {
        await sendWhatsAppMessage(
          from,
          "❌ Comando no reconocido. Envía 'ENTRADA' o 'SALIDA' para registrar tu checada."
        );
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// -----------------------------------------------
// INICIAR CHECADA
// -----------------------------------------------
async function iniciarChecada(numero, empleado, tipo) {
  console.log(`Generando token para ${numero} (${tipo})`);
  const token = generarToken();
  const expiraEn = Date.now() + 2 * 60 * 1000;

  await db.ref(`tokens/${token}`).set({
    numero,
    empresaId: empleado.empresaId,
    tipo,
    expiraEn
  });

  //const link = `https://tudominio.com/checkin.html?token=${token}`;
  const link = `https://checador-7bc7c.web.app/checkin.html?token=${token}&tipo=${tipo}`;

  await sendWhatsAppMessage(
    numero,
    `📍 Para registrar tu *${tipo}*, abre el enlace:\n${link}\n⏱️ Expira en 2 minutos`
  );
}

// -----------------------------------------------
// CHECKIN DESDE WEBAPP
// -----------------------------------------------
app.post("/checkin", async (req, res) => {
  try {
    const { token, lat, lng, accuracy,tipo } = req.body;
    
    if (!token || !lat || !lng) {
      return res.status(400).json({ mensaje: "Datos incompletos" });
    }
   
    if (accuracy > 400) {
      return res.status(403).json({ mensaje: "GPS impreciso" });
    }
  
    const tSnap = await db.ref(`tokens/${token}`).once("value");
    if (!tSnap.exists()) {
      return res.status(403).json({ mensaje: "Token inválido" });
    }

    const t = tSnap.val();

    if (Date.now() > t.expiraEn) {
      await db.ref(`tokens/${token}`).remove();
      return res.status(403).json({ mensaje: "Token expirado" });
    }

    const empresaSnap = await db.ref(`empresa/${t.empresaId}`).once("value");
    const empresa = empresaSnap.val();
    const distancia = calcularDistancia(
      lat,
      lng,
      empresa.lat,
      empresa.lng
    );
    console.log("distancia calculada", distancia);
    if (distancia > empresa.radioMetros) {
      return res.status(403).json({ mensaje: "Fuera de rango" });
    }
    const fecha = new Date();
    const horaMX = fecha.toLocaleString("es-MX", {
      timeZone: "America/Mexico_City"
    });

    
    const cfgSnap = (await db.ref(`diaslaborales/${t.empresaId}`).once('value'));
    //const turnos = (await db.ref(`turnos/${t.empresaId}`).once('value')).val();
 
    if (cfgSnap !== null && !cfgSnap) {
      await sendWhatsApp(numero, "❌ No hay horarios configurados.");
      return;
    }

    const ahora = new Date();
    const horaActual = ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

    const cfg = cfgSnap.val();
    const finSemana = esFinDeSemana();

    let horaEntrada = cfg.horaEntrada;
    let horaSalida = finSemana ? cfg.horafinsemana : cfg.horaSalida;

    if (finSemana && !cfg.findeSemana) {
      await sendWhatsApp(numero, "📅 Hoy no es día laboral.");
      return;
    }

    const horaRef = tipo.toUpperCase() === "ENTRADA" ? horaEntrada : horaSalida;

    const fuera = fueraDeTolerancia(
      horaActual,
      horaRef,
      cfg.tiempoTolerancia
    );

    //const turno = detectarTurno(horaActual, turnos);

    console.log("fuera de tolerancia " + fuera);
    // const fuera = fueraDeTolerancia(
    //   horaActual,
    //   t.tipo === 'ENTRADA' ? turno.entrada : turno.salida,
    //   cfg.tiempoTolerancia

    // );


    await db.ref("checadas").push({
      numero: t.numero,
      empresaId: t.empresaId,
      tipo: t.tipo,
      timestamp: Date.now(),
      hora: horaActual,
      fecha: Date.now(),
      fueraTolerancia: fuera,
      fechahora: horaMX.split(",")[1],
      dia: `${fecha.getFullYear()}-${fecha.getMonth() + 1}-${fecha.getDate()}`,
      hora: horaMX.split(",")[1],
      ubicacion: { lat, lng, accuracy, distancia }
    });

    await db.ref(`tokens/${token}`).remove();

    // -------------------------------
  // FLUJOS
  // -------------------------------
  console.log("Manejo de flujos según tolerancia " + fuera + " y tipo " + tipo);
  if (!fuera && tipo.toUpperCase() === "ENTRADA") {
    await db.ref(`conversaciones/${numero}`).set({
      estado: "MOTIVO_ENTRADA",
      checadaId: ref.key
    });

    await sendWhatsApp(
      numero,
      "⏰ Llegaste tarde.\n✍️ Escribe el *motivo* de tu llegada."
    );
    return;
  }

  if (!fuera && tipo.toUpperCase() === "SALIDA") {
    await db.ref(`conversaciones/${numero}`).set({
      estado: "MOTIVO_SALIDA",
      checadaId: ref.key
    });

    await sendWhatsApp(
      numero,
      "⏰ Salida fuera de horario.\n✍️ Indica el motivo."
    );
    return;
  }

  // await sendWhatsApp(
  //   numero,
  //   `✅ ${tipo} registrada correctamente a las ${horaActual}`
  // );


    await sendWhatsAppMessage(
      t.numero,
      `✅ ${t.tipo} registrada correctamente`
    );

    res.json({ mensaje: "Checada registrada" });

  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

// -----------------------------------------------
// FUERA DE TOLERANCIA
// -----------------------------------------------
function fueraDeTolerancia(horaActual, horaBase, tolerancia) {
  console.log("hora actual recibida", horaActual);
  console.log("hora base recibida", horaBase);
  console.log("tolerancia recibida", tolerancia);
  const [h1, m1] = horaActual.split(':').map(Number);
  const [h2, m2] = horaBase.split(':').map(Number);
  console.log("valor hora actual en minutos", (h1 * 60 + m1));
  console.log("valor hora base en minutos + tolerancia", (h2 * 60 + m2 + tolerancia));
  
  return (h1 * 60 + m1) > (h2 * 60 + m2 + tolerancia);
}

// -----------------------------------------------
// fuera de tolerancia
// -----------------------------------------------
// function fueraDeTolerancia(horaActual, horaRef, tolerancia) {
//   console.log("hora actual recibida", horaActual);
//   console.log("hora referencia recibida", horaRef);
//   const [h1, m1] = horaActual.split(':').map(Number);
//   const [h2, m2] = horaRef.split(':').map(Number);

//   const a = h1 * 60 + m1;
//   console.log("valor a", a);
//   const r = h2 * 60 + m2;
//   console.log("valor r", r);
//   console.log("valor tolerancia", tolerancia);
//   return a > (r + tolerancia);
// }

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -----------------------------------------------
// DETECTAR TURNO
// -----------------------------------------------

function detectarTurno(hora, turnos = {}) {
  for (const [id, t] of Object.entries(turnos)) {
    if (hora >= t.entrada && hora <= t.salida) return { id, ...t };
  }
  return null;
}


// -----------------------------------------------
// ENVIAR WHATSAPP
// -----------------------------------------------
async function sendWhatsAppMessage(to, text) {
  try {
    console.log("Bearing token:", process.env.WHATSAPP_TOKEN);
    console.log("Sending WhatsApp message to:", to.replace("+", ""));
    console.log("Message text:", text);
    const response = await fetch(

      `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to.replace("+", ""),
          type: "text",
          text: { body: text }
        })
      }
    );
    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Error WhatsApp:", data);
      throw new Error(data.error?.message || "Error enviando WhatsApp");
    }

    return data;

  } catch (error) {
    console.error("Error enviando mensaje WhatsApp:", error);
  }
}

// -----------------------------------------------
app.listen(3000, () =>
  console.log("Servidor corriendo en puerto 3000")
);
