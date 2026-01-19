process.env.TZ = 'America/Mexico_City';

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const crypto = require("crypto");
const cors = require("cors");
const fetch = require("node-fetch");

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
    //const from = body.From.replace("whatsapp:", "");
    console.log("Body recibido:", JSON.stringify(body));
    const msgType = body.MessageType;
    const message = body.Body ? body.Body.toLowerCase().trim() : "";
    console.log("Mensaje recibido:", message);
    //const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    //const from = message.from;
    const type = message.type;

    const empleadoSnap = await db.ref(`empleados/${from}`).once("value");
    if (!empleadoSnap.exists()) {
      await sendWhatsAppMessage(from, "❌ Tu número no está registrado.");
      return res.sendStatus(200);
    }

    const empleado = empleadoSnap.val();

    if (type === "text") {
      const text = message.text.body.toLowerCase().trim();

      if (text === "entrada" || text === "salida") {
        await iniciarChecada(from, empleado, text.toUpperCase());
      }else {
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
  const token = generarToken();
  const expiraEn = Date.now() + 2 * 60 * 1000;

  await db.ref(`tokens/${token}`).set({
    numero,
    empresaId: empleado.empresaId,
    tipo,
    expiraEn
  });

  //const link = `https://tudominio.com/checkin.html?token=${token}`;
   const link = `https://checador-7bc7c.web.app/checkin.html?token=${token}`;

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
    const { token, lat, lng, accuracy } = req.body;

    if (!token || !lat || !lng) {
      return res.status(400).json({ mensaje: "Datos incompletos" });
    }

    if (accuracy > 40) {
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

    if (distancia > empresa.radioMetros) {
      return res.status(403).json({ mensaje: "Fuera de rango" });
    }

    await db.ref("checadas").push({
      numero: t.numero,
      empresaId: t.empresaId,
      tipo: t.tipo,
      timestamp: Date.now(),
      ubicacion: { lat, lng, accuracy, distancia }
    });

    await db.ref(`tokens/${token}`).remove();

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
// ENVIAR WHATSAPP
// -----------------------------------------------
async function sendWhatsAppMessage(to, text) {
  await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: { body: text }
      })
    }
  );
}

// -----------------------------------------------
app.listen(3000, () =>
  console.log("Servidor corriendo en puerto 3000")
);
